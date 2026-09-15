using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using IntelOrca.PeggleEdit.Tools.Levels;
using IntelOrca.PeggleEdit.Tools.Levels.Children;
using IntelOrca.PeggleEdit.Tools.Pack;

internal static class Program
{
    private const string ToolVersion = "0.4.0";
    private const int PlayfieldWidth = 646;
    private const int PlayfieldHeight = 543;
    private const int ScreenWidth = 800;
    private const int ScreenHeight = 600;
    private const int EntryDrawOffsetX = 73;
    private const int EntryDrawOffsetY = 43;
    private const int BackgroundDrawOffsetX = 73;
    private const int BackgroundDrawOffsetY = 53;
    private const int LaunchAxisX = 327;

    private static int Main(string[] args)
    {
        if (args.Length < 2)
        {
            PrintUsage();
            return 2;
        }

        var input = Path.GetFullPath(args[0]);
        var isPak = String.Equals(Path.GetExtension(input), ".pak", StringComparison.OrdinalIgnoreCase);
        if (isPak && String.Equals(args[1], "--list", StringComparison.OrdinalIgnoreCase))
            return ListPakLevels(input);
        if (isPak && args.Length < 4)
        {
            PrintUsage();
            return 2;
        }

        var output = Path.GetFullPath(args[1]);
        var revision = args.Length >= 3 ? args[2] : "unknown";
        var sourceSystem = InferSourceSystem(input);
        try
        {
            Level level;
            var sourcePath = input;
            var sourceSha256 = Sha256(input);
            string archivePath = null;
            string archiveSha256 = null;
            string archiveEntry = null;
            string backgroundEntry = null;
            string backgroundSha256 = null;
            LevelReader reader;
            if (isPak)
            {
                archivePath = input;
                archiveSha256 = sourceSha256;
                var pak = new PakCollection(input);
                var requestedEntry = args[3].Replace('/', '\\');
                var pakRecord = pak.GetRecord(requestedEntry);
                if (pakRecord == null)
                    throw new FileNotFoundException("PAK entry not found. Run with --list to inspect level entries.", requestedEntry);
                archiveEntry = pakRecord.FileName;
                sourcePath = input + "#" + archiveEntry.Replace('\\', '/');
                sourceSha256 = Sha256(pakRecord.Buffer);
                var backgroundRecord = pak.FindFirstRecordWithExtension(pakRecord.FileName, ".jp2", ".jpg", ".png");
                if (backgroundRecord != null)
                {
                    backgroundEntry = backgroundRecord.FileName;
                    backgroundSha256 = Sha256(backgroundRecord.Buffer);
                }
                reader = new LevelReader(pakRecord.Buffer);
            }
            else
            {
                reader = new LevelReader(input);
            }

            using (reader)
            {
                level = reader.Read();
                if (level == null)
                    throw new InvalidDataException(reader.Error ?? "PeggleEdit LevelReader returned null.");
            }

            var record = BuildRecord(
                level,
                sourcePath,
                sourceSha256,
                revision,
                archivePath,
                archiveSha256,
                archiveEntry,
                backgroundEntry,
                backgroundSha256,
                sourceSystem
            );
            var serializer = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 128 };
            var outputDirectory = Path.GetDirectoryName(output);
            if (!String.IsNullOrEmpty(outputDirectory)) Directory.CreateDirectory(outputDirectory);
            File.WriteAllText(output, serializer.Serialize(record) + Environment.NewLine, new UTF8Encoding(false));
            var authored = (Dictionary<string, object>)record["authored"];
            Console.WriteLine("wrote {0} ({1} objects)", output, ((IList)authored["objects"]).Count);
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.ToString());
            return 1;
        }
    }

    private static void PrintUsage()
    {
        Console.Error.WriteLine("Usage: PeggleEditExporter.exe <level.dat> <output.json> [source-revision]");
        Console.Error.WriteLine("       PeggleEditExporter.exe <main.pak> --list");
        Console.Error.WriteLine("       PeggleEditExporter.exe <main.pak> <output.json> <source-revision> <levels\\name.dat>");
    }

    private static string InferSourceSystem(string input)
    {
        var normalized = input.Replace('\\', '/').ToLowerInvariant();
        if (normalized.Contains("peggle deluxe")) return "peggle-deluxe";
        if (normalized.Contains("peggle nights")) return "peggle-nights";
        return "peggle-classic";
    }

    private static int ListPakLevels(string input)
    {
        try
        {
            var pak = new PakCollection(input);
            foreach (var record in pak.Records.Where(record =>
                String.Equals(Path.GetExtension(record.FileName), ".dat", StringComparison.OrdinalIgnoreCase)))
                Console.WriteLine(record.FileName);
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.ToString());
            return 1;
        }
    }

    private static Dictionary<string, object> BuildRecord(
        Level level,
        string sourcePath,
        string sourceSha256,
        string revision,
        string archivePath,
        string archiveSha256,
        string archiveEntry,
        string backgroundEntry,
        string backgroundSha256,
        string sourceSystem)
    {
        var entries = level.Entries.Cast<LevelEntry>().ToList();
        var objects = entries.Select((entry, index) => ConvertEntry(entry, index)).Cast<object>().ToList();
        var warnings = objects
            .Cast<Dictionary<string, object>>()
            .Where(item => (string)item["kind"] == "unknown")
            .Select(item => "Unknown PeggleEdit entry preserved: " + item["id"])
            .Cast<object>()
            .ToList();
        var sourceLevelName = level.Info.Name;
        var archiveStem = Path.GetFileNameWithoutExtension(archiveEntry ?? sourcePath);
        var levelName = !String.IsNullOrWhiteSpace(sourceLevelName)
            && !String.Equals(sourceLevelName, "Untitled Level", StringComparison.OrdinalIgnoreCase)
            ? sourceLevelName
            : archiveStem;
        var idSlug = Slug(levelName);
        var authored = Dict(
            "name", levelName,
            "coordinateSystem", Dict(
                "units", "source-pixel",
                "origin", "top-left",
                "xAxis", "right",
                "yAxis", "down",
                "orientation", "landscape",
                "bounds", Dict("minX", 0, "minY", 0, "maxX", PlayfieldWidth, "maxY", PlayfieldHeight),
                "viewport", Dict("width", PlayfieldWidth, "height", PlayfieldHeight),
                "revision", "peggleedit-playfield-v1",
                "sourceFrame", Dict(
                    "screen", Dict("width", ScreenWidth, "height", ScreenHeight),
                    "entryDrawOffset", Dict("x", EntryDrawOffsetX, "y", EntryDrawOffsetY),
                    "backgroundDrawOffset", Dict("x", BackgroundDrawOffsetX, "y", BackgroundDrawOffsetY)
                )
            ),
            "objects", objects,
            "groups", new List<object>(),
            "mechanics", Dict(
                "mode", "classic",
                "sourceParser", "PeggleEdit LevelReader",
                "launchAxis", Dict(
                    "x", LaunchAxisX,
                    "coordinateSpace", "source-playfield",
                    "evidence", "full-screen-center-minus-PeggleEdit-Level.DrawAdjustX"
                )
            ),
            "tags", new List<object> { "classic-peggle", sourceSystem, "professional-corpus", "landscape-source" },
            "metadata", Dict(
                "peggleEditLevelHash", level.Hash.ToString(CultureInfo.InvariantCulture),
                "sourceArchiveEntry", archiveEntry,
                "sourceLevelInfo", SerializeObject(level.Info, 0, new HashSet<object>(ReferenceComparer.Instance))
            )
        );
        var visual = Dict("presentation", Dict("source", sourceSystem));
        if (backgroundEntry != null)
        {
            visual["background"] = Dict(
                "kind", "background",
                "path", archivePath + "#" + backgroundEntry.Replace('\\', '/'),
                "sha256", backgroundSha256,
                "mediaType", MediaTypeFor(backgroundEntry),
                "metadata", Dict("archiveEntry", backgroundEntry, "extracted", false)
            );
        }
        var record = Dict(
            "format", "peggle-research",
            "formatVersion", 1,
            "recordType", "level",
            "id", "level:" + sourceSystem + ":" + idSlug,
            "provenance", Dict(
                "source", Dict(
                    "system", sourceSystem,
                    "path", sourcePath,
                    "revision", revision,
                    "sha256", sourceSha256
                ),
                "ingestion", Dict(
                    "tool", "PeggleEditExporter",
                    "toolVersion", ToolVersion,
                    "toolRevision", revision,
                    "at", DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)
                )
            ),
            "authored", authored,
            "visual", visual,
            "extensions", Dict(
                "parser", Dict("name", "IntelOrca.PeggleEdit.Tools.LevelReader", "revision", revision),
                "archive", archivePath == null ? null : Dict(
                    "path", archivePath,
                    "sha256", archiveSha256,
                    "entry", archiveEntry,
                    "backgroundEntry", backgroundEntry,
                    "backgroundSha256", backgroundSha256
                )
            ),
            "warnings", warnings,
            "losses", new List<object>()
        );
        return record;
    }

    private static Dictionary<string, object> ConvertEntry(LevelEntry entry, int index)
    {
        var kind = KindFor(entry);
        var role = entry is Teleport || entry is Emitter
            ? "trigger"
            : (entry.HasPegInfo ? "target" : (entry.Collision ? "obstacle" : "decoration"));
        var sourceRotationDegrees = NumberProperty(entry, "Rotation", "Angle");
        var estimatedRotationDegrees = sourceRotationDegrees;
        if (entry.MovementLink?.Movement is Movement movement)
            estimatedRotationDegrees = movement.GetEstimatedMoveAngle((float)sourceRotationDegrees);
        var visualRotationDegrees = VisualRotationDegrees(entry, estimatedRotationDegrees);
        var visualX = SafeNumber(entry.DrawX);
        var visualY = SafeNumber(entry.DrawY);
        var geometry = GeometryFor(entry, visualX, visualY, visualRotationDegrees);
        var sourceId = String.IsNullOrWhiteSpace(entry.ID) ? null : entry.ID;
        var id = String.Format(CultureInfo.InvariantCulture, "entry-{0:D4}", index);
        var result = Dict(
            "id", id,
            "kind", kind,
            "role", role,
            "targetType", entry.HasPegInfo ? "classic-variable" : null,
            "transform", Dict(
                "x", visualX,
                "y", visualY,
                "rotation", SafeNumber(visualRotationDegrees * Math.PI / 180.0),
                "scaleX", 1,
                "scaleY", 1
            ),
            "geometry", geometry,
            "groupIds", new List<object>(),
            "properties", Dict(
                "collidable", entry.Collision,
                "visible", entry.Visible,
                "canMove", entry.CanMove,
                "presentationSnapshot", entry.MovementLink == null ? "authored-static" : "source-initial-phase",
                "sourceId", sourceId,
                "sourceType", entry.Type
            ),
            "source", Dict(
                "system", "peggleedit-levelreader",
                "index", index,
                "class", entry.Type,
                "runtimeType", entry.GetType().FullName,
                "authoredTransform", Dict(
                    "x", SafeNumber(entry.X),
                    "y", SafeNumber(entry.Y),
                    "rotationDegrees", SafeNumber(sourceRotationDegrees)
                ),
                "presentationTransform", Dict(
                    "x", visualX,
                    "y", visualY,
                    "sourceRotationDegrees", SafeNumber(estimatedRotationDegrees),
                    "canonicalRotationDegrees", SafeNumber(visualRotationDegrees)
                ),
                "raw", SerializeObject(entry, 0, new HashSet<object>(ReferenceComparer.Instance))
            )
        );
        if (entry.MovementLink != null)
            result["movement"] = SerializeObject(entry.MovementLink, 0, new HashSet<object>(ReferenceComparer.Instance));
        if (entry is Teleport teleport)
        {
            result["portal"] = Dict(
                "destinationId", null,
                "destinationPosition", Dict("x", SafeNumber(teleport.DestinationX), "y", SafeNumber(teleport.DestinationY)),
                "pairing", "embedded-destination"
            );
        }
        return result;
    }

    private static string KindFor(LevelEntry entry)
    {
        if (entry is Circle) return "circle";
        if (entry is Brick) return "brick";
        if (entry is Rod) return "rod";
        if (entry is Polygon) return "polygon";
        if (entry is Teleport) return "portal";
        if (entry is Emitter) return "emitter";
        return "unknown";
    }

    private static double VisualRotationDegrees(LevelEntry entry, double sourceRotationDegrees)
    {
        // PeggleEdit's source angle is not the angle of the long axis used by the
        // canonical/web renderer. Straight bricks are drawn at -angle + 90;
        // curved bricks are drawn at -angle around their annulus origin.
        if (entry is Brick brick)
            return brick.Curved ? -sourceRotationDegrees : 90.0 - sourceRotationDegrees;
        return sourceRotationDegrees;
    }

    private static List<object> CurveSlices(
        double midpointX,
        double midpointY,
        double visualRotationDegrees,
        double innerRadius,
        double outerRadius,
        double sectorAngleDegrees,
        int requestedPointCount)
    {
        var pointCount = Math.Max(2, Math.Min(257, requestedPointCount));
        var centreRadius = (innerRadius + outerRadius) / 2.0;
        var middleAngle = visualRotationDegrees * Math.PI / 180.0;
        var originX = midpointX - Math.Cos(middleAngle) * centreRadius;
        var originY = midpointY - Math.Sin(middleAngle) * centreRadius;
        var startAngle = middleAngle - (sectorAngleDegrees * Math.PI / 360.0);
        var totalAngle = sectorAngleDegrees * Math.PI / 180.0;
        var result = new List<object>();
        for (var index = 0; index < pointCount; index++)
        {
            var fraction = pointCount == 1 ? 0.0 : (double)index / (pointCount - 1);
            var angle = startAngle + totalAngle * fraction;
            var normalX = Math.Cos(angle);
            var normalY = Math.Sin(angle);
            result.Add(Dict(
                "x", SafeNumber(originX + normalX * centreRadius),
                "y", SafeNumber(originY + normalY * centreRadius),
                "nx", SafeNumber(normalX),
                "ny", SafeNumber(normalY)
            ));
        }
        return result;
    }

    private static Dictionary<string, object> GeometryFor(
        LevelEntry entry,
        double visualX,
        double visualY,
        double visualRotationDegrees)
    {
        if (entry is Circle circle)
            return Dict("shape", "circle", "radius", SafeNumber(circle.Radius));
        if (entry is Brick brick)
        {
            if (!brick.Curved)
                return Dict(
                    "shape", "rotated-rectangle",
                    "width", SafeNumber(brick.Length),
                    "height", SafeNumber(brick.Width),
                    "curved", false
                );

            var innerRadius = SafeNumber(brick.InnerRadius);
            var outerRadius = SafeNumber(brick.OuterRadius);
            var centreRadius = (innerRadius + outerRadius) / 2.0;
            var sectorAngleDegrees = SafeNumber(brick.SectorAngle);
            var arcLength = centreRadius * Math.Abs(sectorAngleDegrees) * Math.PI / 180.0;
            return Dict(
                "shape", "annular-sector",
                "width", SafeNumber(arcLength),
                "height", SafeNumber(brick.Width),
                "innerRadius", innerRadius,
                "outerRadius", outerRadius,
                "centerRadius", SafeNumber(centreRadius),
                "sectorAngleDegrees", sectorAngleDegrees,
                "curved", true,
                "curvePoints", brick.CurvePoints,
                "curveSlices", CurveSlices(
                    visualX,
                    visualY,
                    visualRotationDegrees,
                    innerRadius,
                    outerRadius,
                    sectorAngleDegrees,
                    brick.CurvePoints)
            );
        }
        if (entry is Rod rod)
            return Dict(
                "x1", SafeNumber(rod.PointAX), "y1", SafeNumber(rod.PointAY),
                "x2", SafeNumber(rod.PointBX), "y2", SafeNumber(rod.PointBY)
            );
        if (entry is Polygon polygon)
            return Dict(
                "shape", "polygon",
                "coordinateSpace", "local",
                "points", polygon.GetPoints().Select(PointDictionary).Cast<object>().ToList()
            );
        if (entry is Teleport teleport)
            return Dict("shape", "rectangle", "width", teleport.Width, "height", teleport.Height);
        return Dict();
    }

    private static Dictionary<string, object> PointDictionary(PointF point)
    {
        return Dict("x", SafeNumber(point.X), "y", SafeNumber(point.Y));
    }

    private static object SerializeObject(object value, int depth, HashSet<object> seen)
    {
        if (value == null) return null;
        if (depth > 8) return "[depth-limit]";
        var type = value.GetType();
        if (type.IsEnum) return value.ToString();
        if (value is string || value is bool || value is byte || value is short || value is int || value is long ||
            value is ushort || value is uint || value is ulong || value is decimal)
            return value;
        if (value is float f) return SafeNumber(f);
        if (value is double d) return SafeNumber(d);
        if (value is Color color) return Dict("argb", color.ToArgb(), "html", ColorTranslator.ToHtml(color));
        if (value is PointF point) return PointDictionary(point);
        if (value is Point intPoint) return Dict("x", intPoint.X, "y", intPoint.Y);
        if (value is IEnumerable enumerable)
        {
            var list = new List<object>();
            foreach (var item in enumerable) list.Add(SerializeObject(item, depth + 1, seen));
            return list;
        }
        if (!type.IsValueType)
        {
            if (seen.Contains(value)) return "[cycle]";
            seen.Add(value);
        }
        var result = new Dictionary<string, object>();
        foreach (var property in type.GetProperties(BindingFlags.Instance | BindingFlags.Public).OrderBy(p => p.Name))
        {
            if (!property.CanRead || property.GetIndexParameters().Length != 0) continue;
            if (new[] { "Level", "Parent", "Bounds", "DrawLocation", "MouseOver", "Selected", "Provisional" }.Contains(property.Name)) continue;
            try
            {
                result[property.Name] = SerializeObject(property.GetValue(value, null), depth + 1, seen);
            }
            catch (Exception ex)
            {
                result[property.Name] = "[unreadable:" + ex.GetType().Name + "]";
            }
        }
        if (!type.IsValueType) seen.Remove(value);
        return result;
    }

    private static double NumberProperty(object value, params string[] names)
    {
        foreach (var name in names)
        {
            var property = value.GetType().GetProperty(name, BindingFlags.Instance | BindingFlags.Public);
            if (property == null || !property.CanRead) continue;
            var raw = property.GetValue(value, null);
            if (raw is IConvertible convertible)
            {
                try { return convertible.ToDouble(CultureInfo.InvariantCulture); }
                catch { }
            }
        }
        return 0;
    }

    private static double SafeNumber(double value) => Double.IsNaN(value) || Double.IsInfinity(value) ? 0 : value;

    private static string Sha256(string path)
    {
        using (var algorithm = SHA256.Create())
        using (var stream = File.OpenRead(path))
            return String.Concat(algorithm.ComputeHash(stream).Select(b => b.ToString("x2", CultureInfo.InvariantCulture)));
    }

    private static string Sha256(byte[] buffer)
    {
        using (var algorithm = SHA256.Create())
            return String.Concat(algorithm.ComputeHash(buffer).Select(b => b.ToString("x2", CultureInfo.InvariantCulture)));
    }

    private static string MediaTypeFor(string path)
    {
        switch (Path.GetExtension(path).ToLowerInvariant())
        {
            case ".jp2": return "image/jp2";
            case ".jpg":
            case ".jpeg": return "image/jpeg";
            case ".png": return "image/png";
            default: return "application/octet-stream";
        }
    }

    private static string Slug(string value)
    {
        var output = new StringBuilder();
        var priorDash = false;
        foreach (var c in value.ToLowerInvariant())
        {
            if (Char.IsLetterOrDigit(c)) { output.Append(c); priorDash = false; }
            else if (!priorDash) { output.Append('-'); priorDash = true; }
        }
        return output.ToString().Trim('-');
    }

    private static Dictionary<string, object> Dict(params object[] pairs)
    {
        var result = new Dictionary<string, object>();
        for (var i = 0; i + 1 < pairs.Length; i += 2) result[(string)pairs[i]] = pairs[i + 1];
        return result;
    }

    private sealed class ReferenceComparer : IEqualityComparer<object>
    {
        internal static readonly ReferenceComparer Instance = new ReferenceComparer();
        public new bool Equals(object x, object y) => ReferenceEquals(x, y);
        public int GetHashCode(object obj) => System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(obj);
    }
}
