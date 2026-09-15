# PeggleEdit-backed classic Peggle exporter

This adapter deliberately uses PeggleEdit's current `LevelReader`; it does not
reimplement the Deluxe/Nights binary format. The canonical source system is
inferred from the installation directory (`peggle-deluxe`, `peggle-nights`, or
the conservative fallback `peggle-classic`).

Build against an exact PeggleEdit checkout:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File research\tools\peggleedit-exporter\build.ps1 -PeggleEditRoot ..\upstream\PeggleEdit
```

Then run the generated .NET Framework-compatible executable directly against a
Nights `main.pak` entry (no commercial files are copied into the repository):

```powershell
.\research\tools\peggleedit-exporter\bin\Release\net472\PeggleEditExporter.exe '..\Peggle Nights\main.pak' --list
.\research\tools\peggleedit-exporter\bin\Release\net472\PeggleEditExporter.exe '..\Peggle Nights\main.pak' research\generated\nights-level.json aea17bb5bf7737d11c8d2f9d75dc87770f9b8581 'levels\name.dat'
node research\tools\validate-record.mjs research\generated\nights-level.json
```

An extracted `.dat` remains supported with the shorter original form:

```powershell
.\research\tools\peggleedit-exporter\bin\Release\net472\PeggleEditExporter.exe level.dat research\generated\nights-level.json aea17bb5bf7737d11c8d2f9d75dc87770f9b8581
```

PeggleEdit targets .NET Framework 4.7.2 and references WinForms/System.Drawing.
A modern Visual Studio MSBuild or compatible .NET SDK is therefore a toolchain
prerequisite. The build helper checks the system toolchain and then an optional
portable SDK at `research/.tools/dotnet/`. The adapter privately references
Microsoft's .NET Framework reference-assemblies package so a machine-wide 4.7.2
developer pack is not required. Keep the PeggleEdit revision, PAK hash, entry
name, and entry digest in every output record.
