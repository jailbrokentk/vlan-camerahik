cmake_minimum_required(VERSION 3.10)
project(iVMS_Popout_Patch LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Configure MSVC compilation options
if(MSVC)
    add_compile_options(/W4 /WX- /Od /Oy- /Gm- /EHsc /MT /GS /fp:precise /Zc:wchar_t /Zc:forScope /Zc:inline)
    add_link_options(/DYNAMICBASE /NXCOMPAT)
endif()

# Configure GCC/MinGW static linking to prevent missing runtime DLL errors
if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "GNU")
    add_link_options(-static -static-libgcc -static-libstdc++)
endif()

# 1. Target: iVMS_Popout (Patch DLL)
add_library(iVMS_Popout SHARED dllmain.cpp)
target_link_libraries(iVMS_Popout PRIVATE
    user32
    kernel32
    gdi32
)

# 2. Target: BitrateLauncher (Launcher EXE)
add_executable(BitrateLauncher launcher.cpp)
target_link_libraries(BitrateLauncher PRIVATE
    user32
    kernel32
    advapi32
)
if(MSVC)
    set_target_properties(BitrateLauncher PROPERTIES
        LINK_FLAGS "/MANIFESTUAC:\"level='requireAdministrator' uiAccess='false'\""
    )
endif()

# Output directories configuration
set_target_properties(iVMS_Popout PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
    LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
)

set_target_properties(BitrateLauncher PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
)
