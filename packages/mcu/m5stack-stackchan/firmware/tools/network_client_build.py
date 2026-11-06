"""Replace only the pinned Arduino WiFiClient source; never patch shared SDKs."""

from hashlib import sha256
import os
from pathlib import Path
import re
import subprocess

Import("env")

if env.BoardConfig().get("build.mcu") != "esp32s3":
    raise RuntimeError("PulseNetworkClient is pinned to the ESP32-S3 target")

framework = Path(env.PioPlatform().get_package_dir("framework-arduinoespressif32"))
original = (framework / "libraries/WiFi/src/WiFiClient.cpp").resolve()
vendor = (Path(env.subst("$PROJECT_DIR")) / "lib/PulseNetworkClient/vendor/WiFiClient.cpp").resolve()
base_sha256 = "87f2786b1d7c4617eb4de7e0ada8da1da7c684c35da4ace39b3d051bfaf7494a"
if sha256(original.read_bytes().replace(b"\r\n", b"\n")).hexdigest() != base_sha256:
    raise RuntimeError("WiFiClient SDK differs from pinned Arduino 2.0.17; review the backport")
if not vendor.is_file():
    raise RuntimeError("Project-local WiFiClient backport is missing")

replacement_objects = []


def replace_wifi_client(build_env, node):
    if Path(node.srcnode().get_abspath()).resolve() != original:
        return node
    if replacement_objects:
        raise RuntimeError("WiFiClient compilation input was encountered more than once")
    # Preserve WiFiClient.cpp.o as the archive member name. Using a different
    # name could leave an old member in a cached libWiFi.a after ar updates.
    result = build_env.Object(target=node.get_abspath() + ".o", source=str(vendor))
    replacement_objects.extend(result)
    print("[network-client] Arduino 2.0.17 WiFiClient -> project PR10640 backport")
    return result[0]


env.AddBuildMiddleware(replace_wifi_client)


def verify_network_client_link(source, target, env):
    if len(replacement_objects) != 1:
        raise RuntimeError("Expected exactly one WiFiClient source replacement")
    elf = Path(str(target[0]))
    map_text = elf.with_suffix(".map").read_text(encoding="utf-8", errors="replace")
    origins = re.findall(
        r"^_ZN10WiFiClient9connectedEv[ \t]+(.+libWiFi\.a)\(WiFiClient\.cpp\.o\)[ \t]*$",
        map_text, re.MULTILINE,
    )
    if len(origins) != 1:
        raise RuntimeError("Link map does not identify exactly one WiFiClient::connected provider")
    toolchain = Path(env.PioPlatform().get_package_dir("toolchain-xtensa-esp32s3")) / "bin"
    suffix = ".exe" if os.name == "nt" else ""
    archiver = toolchain / ("xtensa-esp32s3-elf-ar" + suffix)
    nm = toolchain / ("xtensa-esp32s3-elf-nm" + suffix)
    archived = subprocess.check_output([str(archiver), "p", origins[0], "WiFiClient.cpp.o"])
    if archived != Path(replacement_objects[0].get_abspath()).read_bytes():
        raise RuntimeError("Linked WiFiClient archive member is not the project backport object")
    symbols = subprocess.check_output([str(nm), "-C", "--defined-only", str(elf)], text=True)
    definitions = re.findall(r"^[0-9a-fA-F]+\s+T\s+WiFiClient::connected\(\)\s*$", symbols, re.MULTILINE)
    if len(definitions) != 1:
        raise RuntimeError("Expected a single linked WiFiClient::connected implementation")
    print("[network-client-link] unique PR10640 backport; SDK archive member replaced")


env.AddPostAction("$BUILD_DIR/${PROGNAME}.elf", verify_network_client_link)
