{
    "targets": [
        {
            "target_name": "diagnostic_hub_rename_noreplace",
            "sources": ["rename-noreplace.c"],
            "defines": ["NAPI_VERSION=8"],
            "cflags": ["-std=c17", "-Wall", "-Wextra", "-Werror", "-fvisibility=hidden"]
        }
    ]
}
