# get IDF version for comparison
set(idf_version "${IDF_VERSION_MAJOR}.${IDF_VERSION_MINOR}")

# set conversion sources
set(srcs
  conversions/yuv.c
  conversions/to_jpg.cpp
  conversions/to_bmp.c
  conversions/jpge.cpp
  conversions/esp_jpg_decode.c
  )

set(priv_include_dirs
  conversions/private_include
  )

set(include_dirs
  driver/include
  conversions/include
  )

set(COMPONENT_REQUIRES driver)

# set driver sources only for supported platforms
if(IDF_TARGET STREQUAL "esp32" OR IDF_TARGET STREQUAL "esp32s2" OR IDF_TARGET STREQUAL "esp32s3")
  list(APPEND srcs
    driver/esp_camera.c
    driver/cam_hal.c
    driver/sccb.c
    driver/sensor.c
    sensors/ov2640.c
    sensors/ov3660.c
    sensors/ov5640.c
    sensors/ov7725.c
    sensors/ov7670.c
    sensors/nt99141.c
    sensors/gc0308.c
    sensors/gc2145.c
    sensors/gc032a.c
    sensors/bf3005.c
    sensors/bf20a6.c
    sensors/sc101iot.c
    sensors/sc030iot.c
    sensors/sc031gs.c
    )

  list(APPEND priv_include_dirs
    driver/private_include
    sensors/private_include
    target/private_include
    )

  if(IDF_TARGET STREQUAL "esp32")
    list(APPEND srcs
      target/xclk.c
      target/esp32/ll_cam.c
      )
  endif()

  if(IDF_TARGET STREQUAL "esp32s2")
    list(APPEND srcs
      target/xclk.c
      target/esp32s2/ll_cam.c
      target/tjpgd.c
      )

    list(APPEND priv_include_dirs
      target/esp32s2/private_include
      )
  endif()

  if(IDF_TARGET STREQUAL "esp32s3")
    list(APPEND srcs
      target/esp32s3/ll_cam.c
      )
  endif()

  set(priv_requires freertos nvs_flash)

  set(min_version_for_esp_timer "4.2")
  if (idf_version VERSION_GREATER_EQUAL min_version_for_esp_timer)
    list(APPEND priv_requires esp_timer)
  endif()

endif()

# CONFIG_ESP_ROM_HAS_JPEG_DECODE is available from IDF v4.4 but
# previous IDF supported chips already support JPEG decoder, hence okay to use this
if(idf_version VERSION_GREATER_EQUAL "4.4" AND NOT CONFIG_ESP_ROM_HAS_JPEG_DECODE)
  list(APPEND srcs
    target/tjpgd.c
  )
  list(APPEND priv_include_dirs
    target/jpeg_include/
  )
endif()

idf_component_register(
  SRCS ${srcs}
  INCLUDE_DIRS ${include_dirs}
  PRIV_INCLUDE_DIRS ${priv_include_dirs}
  REQUIRES driver  # due to include of driver/gpio.h in esp_camera.h
  PRIV_REQUIRES ${priv_requires}
)
