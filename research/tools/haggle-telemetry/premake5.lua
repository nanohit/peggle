newoption {
    trigger = "haggle-root",
    value = "PATH",
    description = "Path to a pinned Haggle checkout"
}

local root = _OPTIONS["haggle-root"]
if not root then
    error("--haggle-root is required")
end
root = path.getabsolute(root)
local here = path.getabsolute(_SCRIPT_DIR)
local launcher = path.getabsolute(path.join(here, "../haggle-launcher"))
local fastmod = path.getabsolute(path.join(here, "../peggle-fast-mod"))
local nativecapture = path.getabsolute(path.join(here, "../native-capture"))

workspace "PeggleResearchTelemetry"
    location(path.join(here, "build"))
    targetdir(path.join(here, "build/bin/%{cfg.buildcfg}-%{cfg.platform}"))
    objdir(path.join(here, "build/obj/%{prj.name}/%{cfg.buildcfg}-%{cfg.platform}"))
    architecture "x86"
    platforms { "x86" }
    configurations { "Release", "Debug" }
    systemversion "latest"
    characterset "unicode"
    staticruntime "on"
    editandcontinue "off"
    largeaddressaware "on"
    defines { "_SILENCE_ALL_CXX17_DEPRECATION_WARNINGS" }

    filter "configurations:Release"
        optimize "full"
        symbols "off"
        defines "NDEBUG"
    filter "configurations:Debug"
        optimize "debug"
        symbols "on"
        defines "DEBUG"
    filter {}

project "MinHook"
    kind "StaticLib"
    language "C++"
    targetname "MinHook"
    files { path.join(root, "deps/minhook/src/**") }
    includedirs { path.join(root, "deps/minhook/include") }

project "Haggle"
    kind "SharedLib"
    language "C++"
    targetname "haggle-sdk"
    warnings "off"
    pchheader "stdafx.hpp"
    pchsource(path.join(root, "src/haggle/stdafx.cpp"))
    forceincludes "stdafx.hpp"
    files { path.join(root, "src/haggle/**") }
    includedirs { path.join(root, "src/haggle"), path.join(root, "deps/minhook/include") }
    links { "MinHook" }
    dependson { "MinHook" }

project "Research-Telemetry-Mod"
    kind "SharedLib"
    language "C++"
    targetname "research-telemetry-mod"
    warnings "off"
    pchheader "stdafx.hpp"
    pchsource(path.join(here, "stdafx.cpp"))
    forceincludes "stdafx.hpp"
    files { path.join(here, "**.cpp"), path.join(here, "**.hpp") }
    includedirs { here, path.join(root, "src/haggle"), path.join(root, "deps/minhook/include") }
    links { "MinHook", "Haggle" }
    dependson { "MinHook", "Haggle" }

project "Peggle-Fast-Mod"
    kind "SharedLib"
    language "C++"
    cppdialect "C++17"
    targetname "peggle-fast-mod"
    warnings "extra"
    files {
        path.join(fastmod, "**.cpp"),
        path.join(fastmod, "**.hpp"),
        path.join(here, "speed_control.cpp"),
        path.join(here, "speed_control.hpp")
    }
    includedirs { here, nativecapture, path.join(root, "deps/minhook/include") }
    links { "MinHook" }
    dependson { "MinHook" }

project "Peggle-Fast-Launcher"
    kind "ConsoleApp"
    language "C++"
    cppdialect "C++17"
    targetname "peggle-fast-launcher"
    warnings "extra"
    files { path.join(launcher, "**.cpp"), path.join(launcher, "**.hpp") }
    links { "bcrypt", "advapi32" }

project "Peggle-Capture-Recorder"
    kind "ConsoleApp"
    language "C++"
    cppdialect "C++17"
    targetname "peggle-capture-recorder"
    warnings "extra"
    files { path.join(nativecapture, "**.cpp"), path.join(nativecapture, "**.hpp") }
    includedirs { nativecapture }
    links { "bcrypt", "windowscodecs", "ole32", "gdi32", "user32" }
