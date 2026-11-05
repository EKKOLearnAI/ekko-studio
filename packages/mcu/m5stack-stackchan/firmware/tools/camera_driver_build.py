"""Build the pinned ESP32-S3 camera component instead of the SDK archive."""

from pathlib import Path
import re

Import("env")

if env.BoardConfig().get("build.mcu") != "esp32s3":
    raise RuntimeError("PulseCameraDriver is pinned to the ESP32-S3 target")

driver_root = Path(env.subst("$PROJECT_DIR")) / "lib" / "PulseCameraDriver"

# Arduino 2.0.17 supplies an already-built camera archive with a 2048-byte task
# stack. Removing it is essential: a successful link must use this whole source
# component, rather than silently mixing the vendor HAL with SDK objects.
sdk_camera_names = {"-lesp32-camera", "esp32-camera"}
sdk_libraries = env.get("LIBS", [])
if not any(str(item) in sdk_camera_names for item in sdk_libraries):
    raise RuntimeError("Expected Arduino SDK esp32-camera library was not found")
env.Replace(LIBS=[item for item in sdk_libraries
                  if str(item) not in sdk_camera_names])

public_includes = [driver_root / "driver/include",
                   driver_root / "conversions/include"]
env.Prepend(CPPPATH=[str(path) for path in public_includes])
camera_env = env.Clone()
# The SDK builds this component as ESP-IDF, without Arduino's logging shim.
# Retain that build context and its original tagged ESP_LOG diagnostics.
camera_env.Replace(CPPDEFINES=[
    item for item in camera_env.get("CPPDEFINES", [])
    if (item[0] if isinstance(item, (tuple, list)) else item) != "ARDUINO_ARCH_ESP32"
])
camera_env.Prepend(CPPPATH=[str(driver_root / directory) for directory in (
    "driver/private_include",
    "conversions/private_include",
    "sensors/private_include",
    "target/private_include",
    "target/jpeg_include",
)])

# Exact ESP32-S3/IDF4.4 source set from upstream CMakeLists.txt. The SDK does not
# define CONFIG_ESP_ROM_HAS_JPEG_DECODE, so its component also builds tjpgd.c.
# The unmodified upstream manifest deliberately remains espidf-only; this
# explicit build is the sole Arduino integration and avoids an LDF duplicate.
camera_library = camera_env.BuildLibrary(
    "$BUILD_DIR/PulseCameraDriver",
    str(driver_root),
    src_filter=[
        "-<*>",
        "+<driver/esp_camera.c>",
        "+<driver/cam_hal.c>",
        "+<driver/sccb.c>",
        "+<driver/sensor.c>",
        "+<sensors/*.c>",
        "+<conversions/*.c>",
        "+<conversions/*.cpp>",
        "+<target/esp32s3/ll_cam.c>",
        "+<target/tjpgd.c>",
    ],
)
env.Prepend(LIBS=camera_library)


def verify_camera_link(source, target, env):
    """Fail the build if another camera component was linked by accident."""
    map_path = Path(str(target[0])).with_suffix(".map")
    text = map_path.read_text(encoding="utf-8", errors="replace")
    if "libesp32-camera.a" in text:
        raise RuntimeError("SDK camera archive remains in link map")
    for member in ("esp_camera.c.o", "cam_hal.c.o", "ll_cam.c.o", "gc0308.c.o"):
        pattern = r"libPulseCameraDriver\.a\((?:[^)]*/)?" + re.escape(member) + r"\)"
        if not re.search(pattern, text):
            raise RuntimeError("Vendor camera object absent from map: " + member)
    print("[camera-link] vendor f0bb429; cam_task stack=4096 bytes; SDK camera absent")


env.AddPostAction("$BUILD_DIR/${PROGNAME}.elf", verify_camera_link)
