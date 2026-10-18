cmake_minimum_required(VERSION 3.20)
project(sherpa-onnx-node-arm64 LANGUAGES CXX)
if(NOT MSVC OR NOT CMAKE_GENERATOR_PLATFORM STREQUAL "ARM64")
  message(FATAL_ERROR "Use MSVC with -A ARM64")
endif()

file(GLOB ADDON_SOURCES CONFIGURE_DEPENDS "${SHERPA_SOURCE}/scripts/node-addon-api/src/*.cc")
add_library(sherpa-onnx SHARED ${ADDON_SOURCES})
set_target_properties(sherpa-onnx PROPERTIES
  PREFIX "" SUFFIX ".node" CXX_STANDARD 17
  MSVC_RUNTIME_LIBRARY "MultiThreadedDLL")
target_compile_definitions(sherpa-onnx PRIVATE NAPI_VERSION=8 NAPI_CPP_EXCEPTIONS)
target_compile_options(sherpa-onnx PRIVATE /EHsc)
target_include_directories(sherpa-onnx PRIVATE
  "${NODE_HEADERS}/include/node" "${NODE_ADDON_API}" "${SHERPA_INSTALL}/include")
target_link_libraries(sherpa-onnx PRIVATE
  "${NODE_LIBRARY}" "${SHERPA_INSTALL}/lib/sherpa-onnx-c-api.lib"
  "${SHERPA_INSTALL}/lib/onnxruntime.lib")
