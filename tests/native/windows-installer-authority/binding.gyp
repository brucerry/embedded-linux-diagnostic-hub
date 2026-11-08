{
    "targets": [
        {
            "target_name": "windows_installer_authority",
            "sources": ["authority.cc"],
            "defines": ["NAPI_VERSION=8", "UNICODE", "_UNICODE"],
            "conditions": [
                [
                    "OS=='win'",
                    {
                        "libraries": ["bcrypt.lib", "advapi32.lib", "user32.lib"],
                        "msvs_settings": {
                            "VCCLCompilerTool": {
                                "AdditionalOptions": ["/std:c++17"],
                                "ExceptionHandling": 1
                            }
                        }
                    },
                    { "type": "none" }
                ]
            ]
        }
    ]
}
