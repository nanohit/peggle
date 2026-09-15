#!/usr/bin/env python3
"""Convert Peggle Flash XML or .dat.zip archives to canonical research records.

Only Python's standard library is used. Known geometry is normalized while the
complete decoded source entity is preserved under object.source.raw.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import pathlib
import re
import struct
import zipfile
import xml.etree.ElementTree as ET


TOOL_VERSION = "0.1.0"


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_scalar(text: str | None):
    if text is None:
        return None
    value = text.strip()
    if value.lower() == "true":
        return True
    if value.lower() == "false":
        return False
    if re.fullmatch(r"[-+]?\d+", value):
        try:
            return int(value)
        except ValueError:
            pass
    try:
        number = float(value)
        if math.isfinite(number):
            return number
    except ValueError:
        pass
    return value


def element_to_data(element: ET.Element):
    children = list(element)
    if not children:
        return parse_scalar(element.text)
    result: dict[str, object] = {}
    if element.attrib:
        result["@attributes"] = dict(element.attrib)
    for child in children:
        value = element_to_data(child)
        if child.tag in result:
            current = result[child.tag]
            if not isinstance(current, list):
                result[child.tag] = [current]
            result[child.tag].append(value)
        else:
            result[child.tag] = value
    return result


def child_number(element: ET.Element | None, name: str, default: float = 0.0) -> float:
    if element is None:
        return default
    value = parse_scalar(element.findtext(name))
    return float(value) if isinstance(value, (int, float)) else default


def bool_text(element: ET.Element, name: str, default: bool = False) -> bool:
    value = parse_scalar(element.findtext(name))
    return value if isinstance(value, bool) else default


def read_xml(path: pathlib.Path) -> tuple[bytes, str]:
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path, "r") as archive:
            entries = sorted(name for name in archive.namelist() if name.lower().endswith(".xml"))
            if not entries:
                raise ValueError(f"{path} contains no XML entry")
            if len(entries) > 1:
                raise ValueError(f"{path} contains multiple XML entries; refusing ambiguous import")
            return archive.read(entries[0]), entries[0]
    return path.read_bytes(), path.name


def jpeg_size(path: pathlib.Path) -> tuple[int, int] | None:
    data = path.read_bytes()
    if len(data) < 4 or data[:2] != b"\xff\xd8":
        return None
    offset = 2
    while offset + 9 < len(data):
        if data[offset] != 0xFF:
            offset += 1
            continue
        marker = data[offset + 1]
        offset += 2
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            continue
        if offset + 2 > len(data):
            break
        length = struct.unpack(">H", data[offset:offset + 2])[0]
        if length < 2 or offset + length > len(data):
            break
        if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
            height, width = struct.unpack(">HH", data[offset + 3:offset + 7])
            return width, height
        offset += length
    return None


def polygon_points(poly: ET.Element | None) -> list[dict[str, float]]:
    if poly is None:
        return []
    points = poly.find("points")
    if points is None:
        return []
    xs = [float(parse_scalar(node.text) or 0) for node in points.findall("x")]
    ys = [float(parse_scalar(node.text) or 0) for node in points.findall("y")]
    return [{"x": x, "y": y} for x, y in zip(xs, ys)]


def transform_center(entity: ET.Element) -> tuple[float, float]:
    mover = entity.find("mover")
    poly = entity.find("poly")
    ball = entity.find("ball")
    if ball is not None:
        return child_number(ball, "mx"), child_number(ball, "my")
    if mover is not None:
        x = child_number(mover, "mx", child_number(mover, "mOrigX"))
        y = child_number(mover, "my", child_number(mover, "mOrigY"))
        return x, y
    if poly is not None:
        return child_number(poly, "mx"), child_number(poly, "my")
    return 0.0, 0.0


def convert_entity(entity: ET.Element, index: int) -> tuple[dict, str | None]:
    source_class = int(child_number(entity, "class", -1))
    source_id = entity.findtext("mId")
    object_id = f"ent-{index:04d}"
    x, y = transform_center(entity)
    kind = "unknown"
    role = "unknown"
    geometry: dict[str, object] = {}
    rotation = 0.0
    warning = None

    if source_class == 2 and entity.find("line") is not None:
        line = entity.find("line")
        x1 = child_number(line, "mx1")
        y1 = child_number(line, "my1")
        x2 = child_number(line, "mx2")
        y2 = child_number(line, "my2")
        x, y = (x1 + x2) / 2, (y1 + y2) / 2
        rotation = math.atan2(y2 - y1, x2 - x1)
        kind, role = "segment", "obstacle"
        geometry = {"x1": x1, "y1": y1, "x2": x2, "y2": y2, "thickness": 10.0}
    elif source_class == 3 and entity.find("poly") is not None:
        kind = "polygon"
        role = "obstacle" if bool_text(entity, "mCollidable") else "decoration"
        geometry = {"points": polygon_points(entity.find("poly"))}
    elif source_class == 5 and entity.find("ball") is not None:
        ball = entity.find("ball")
        kind = "circle"
        role = "target" if entity.find("pegInfo") is not None else "obstacle"
        geometry = {"shape": "circle", "radius": child_number(ball, "mRadius", 10.0)}
    elif source_class == 6 and entity.find("brick") is not None:
        brick = entity.find("brick")
        radius = child_number(brick, "mBrickRadius", 25.0)
        thickness = child_number(brick, "mBrickThickness", 20.0)
        rotation = math.radians(child_number(brick, "mBrickRotation", 0.0))
        kind = "brick"
        role = "target" if entity.find("pegInfo") is not None else "obstacle"
        geometry = {
            "shape": "rotated-rectangle",
            "width": radius * 2,
            "height": thickness,
            "brickRadius": radius,
            "brickAngleDegrees": child_number(brick, "mBrickAngle", 0.0),
        }
    elif source_class == 8 and entity.find("hole") is not None:
        hole = entity.find("hole")
        kind, role = "hole", "trigger"
        geometry = {
            "shape": "rectangle",
            "width": child_number(hole, "mWidth"),
            "height": child_number(hole, "mHeight"),
        }
    else:
        warning = f"entity {object_id} class {source_class} has no semantic converter; raw source was preserved"

    converted = {
        "id": object_id,
        "kind": kind,
        "role": role,
        "targetType": "classic-variable" if entity.find("pegInfo") is not None else None,
        "transform": {"x": x, "y": y, "rotation": rotation, "scaleX": 1, "scaleY": 1},
        "geometry": geometry,
        "groupIds": [],
        "properties": {
            "collidable": bool_text(entity, "mCollidable"),
            "movingFlag": bool_text(entity, "mMoving"),
            "visible": bool_text(entity, "mVisible", True),
            "sourceId": source_id,
        },
        "source": {
            "system": "peggle-flash-xml",
            "index": index,
            "class": source_class,
            "raw": element_to_data(entity),
        },
    }
    mover = entity.find("mover")
    if mover is not None:
        converted["movement"] = element_to_data(mover)
    return converted, warning


def build_record(
    input_path: pathlib.Path,
    xml_bytes: bytes,
    xml_entry: str,
    background: pathlib.Path | None,
    revision: str,
    at: str,
) -> dict:
    root = ET.fromstring(xml_bytes)
    if root.tag != "level":
        raise ValueError(f"expected <level> root, found <{root.tag}>")
    objects = []
    warnings = []
    for index, entity in enumerate(root.findall("ent")):
        converted, warning = convert_entity(entity, index)
        objects.append(converted)
        if warning:
            warnings.append(warning)
    source_name = root.attrib.get("name") or input_path.stem
    slug = re.sub(r"[^a-z0-9]+", "-", pathlib.Path(source_name).stem.lower()).strip("-") or "untitled"
    visual: dict[str, object] = {"presentation": {"source": "peggle-flash"}}
    if background:
        dimensions = jpeg_size(background)
        visual["background"] = {
            "kind": "background",
            "path": str(background),
            "sha256": sha256_file(background),
            "mediaType": "image/jpeg",
            **({"width": dimensions[0], "height": dimensions[1]} if dimensions else {}),
        }
    level_version = parse_scalar(root.findtext("version"))
    return {
        "format": "peggle-research",
        "formatVersion": 1,
        "recordType": "level",
        "id": f"level:peggle-flash:{slug}",
        "provenance": {
            "source": {
                "system": "peggle-flash",
                "path": str(input_path),
                "revision": revision,
                "sha256": sha256_file(input_path),
                "version": level_version,
                "archiveEntry": xml_entry,
            },
            "ingestion": {
                "tool": "extract_peggle_flash.py",
                "toolVersion": TOOL_VERSION,
                "toolRevision": revision,
                "at": at,
            },
        },
        "authored": {
            "name": source_name,
            "coordinateSystem": {
                "units": "source-pixel",
                "origin": "top-left",
                "xAxis": "right",
                "yAxis": "down",
                "orientation": "landscape",
                "bounds": {"minX": 0, "minY": 0, "maxX": 800, "maxY": 600},
                "viewport": {"width": 800, "height": 600},
            },
            "objects": objects,
            "groups": [],
            "mechanics": {
                "mode": "classic",
                "sourceLevelVersion": level_version,
                "launcher": {"coordinateSpace": "source-defined"},
                "bucket": {"enabled": True, "sourceDefined": True},
            },
            "tags": ["classic-peggle", "professional-corpus", "landscape-source"],
            "metadata": {},
        },
        "visual": visual,
        "extensions": {
            "sourceRootAttributes": dict(root.attrib),
            "sourceXmlSha256": hashlib.sha256(xml_bytes).hexdigest(),
        },
        "warnings": warnings,
        "losses": [],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=pathlib.Path, help=".dat.zip archive or XML file")
    parser.add_argument("output", type=pathlib.Path, help="canonical output JSON")
    parser.add_argument("--background", type=pathlib.Path, help="paired JPG background")
    parser.add_argument("--revision", default="unknown", help="exact source repository revision")
    parser.add_argument("--at", help="ISO ingestion timestamp (for reproducible fixtures)")
    args = parser.parse_args()
    xml_bytes, xml_entry = read_xml(args.input)
    at = args.at or dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    record = build_record(args.input, xml_bytes, xml_entry, args.background, args.revision, at)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(record, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {args.output} ({len(record['authored']['objects'])} objects, {len(record['warnings'])} warnings)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
