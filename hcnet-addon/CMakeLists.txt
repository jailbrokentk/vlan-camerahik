cmake_minimum_required(VERSION 3.15)
project(hcnet-addon)

# Set C++ standard
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Configure Node-API include paths (provided by cmake-js)
include_directories(${CMAKE_JS_INC})

# Get node-addon-api include directory
execute_process(
    COMMAND node -p "require('node-addon-api').include"
    WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
    OUTPUT_VARIABLE NODE_ADDON_API_DIR
    OUTPUT_STRIP_TRAILING_WHITESPACE
)
string(REPLACE "\"" "" NODE_ADDON_API_DIR "${NODE_ADDON_API_DIR}")
include_directories(${NODE_ADDON_API_DIR})

# Include paths for Hikvision SDK headers
include_directories(include)

# Check for required Hikvision SDK files before compiling
if(NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/include/HCNetSDK.h" OR 
   NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/lib/HCNetSDK.lib" OR
   NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/include/PlayM4.h" OR
   NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/lib/PlayM4.lib")
    message(FATAL_ERROR 
        "\n\n========================================================================\n"
        "[MISSING HIKVISION SDK FILES]\n"
        "Please download the official Hikvision Win64 SDK and copy:\n"
        "  - Headers (e.g. HCNetSDK.h, PlayM4.h) to: hcnet-addon/include/\n"
        "  - Libs (e.g. HCNetSDK.lib, PlayM4.lib) to: hcnet-addon/lib/\n"
        "  - DLLs and HCNetSDKCom/ folder to: resources/sdk/\n"
        "========================================================================\n\n"
    )
endif()

file(GLOB SOURCE_FILES "addon.cpp")

add_library(${PROJECT_NAME} SHARED ${SOURCE_FILES} ${CMAKE_JS_SRC})
set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")

# Link standard Node-API libraries
target_link_libraries(${PROJECT_NAME} ${CMAKE_JS_LIB})

# Link Hikvision SDK libraries on Windows
if(WIN32)
    target_link_libraries(${PROJECT_NAME}
        "${CMAKE_CURRENT_SOURCE_DIR}/lib/HCNetSDK.lib"
        "${CMAKE_CURRENT_SOURCE_DIR}/lib/PlayM4.lib"
    )
endif()
