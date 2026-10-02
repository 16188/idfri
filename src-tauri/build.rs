use std::{env, fs, path::PathBuf};

fn main() {
    tauri_build::build();

    let target = env::var("TARGET").expect("build target");
    let windows = target.contains("windows");
    assert!(
        windows || target == "x86_64-unknown-linux-gnu",
        "IDFRI desktop supports Windows x64 and Linux x64"
    );
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest directory"));
    let source = manifest.join("generated/browser.json");
    println!("cargo:rerun-if-changed={}", source.display());

    let metadata = fs::read_to_string(&source)
        .expect("generated browser metadata is missing; run `bun run desktop:prepare` first");
    let parsed: serde_json::Value =
        serde_json::from_str(&metadata).expect("valid generated browser metadata");
    for key in ["executable", "runtimeVersion"] {
        assert!(
            parsed
                .get(key)
                .and_then(|value| value.as_str())
                .is_some_and(|value| !value.is_empty()),
            "browser metadata is missing {key}"
        );
    }
    assert_eq!(
        parsed.get("executable").and_then(|value| value.as_str()),
        Some(if windows { "chrome.exe" } else { "chrome" }),
        "browser metadata executable does not match the build target"
    );
    assert_eq!(
        parsed
            .get("runtimeVersion")
            .and_then(|value| value.as_str()),
        Some(if windows {
            "idfri-browser@153.0.8010.52-idfri.2"
        } else {
            "ungoogled-chromium@153.0.8010.52-1"
        }),
        "browser metadata runtime does not match the build target"
    );
    let sha256 = parsed
        .get("sha256")
        .and_then(|value| value.as_str())
        .expect("browser metadata is missing sha256");
    assert!(
        sha256.len() == 64
            && sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            && sha256.bytes().any(|byte| byte != b'0'),
        "browser metadata has an invalid sha256"
    );

    let firefox = parsed
        .get("firefox")
        .and_then(|value| value.as_object())
        .expect("browser metadata is missing firefox");
    for key in ["executable", "sha256", "archiveSha256", "version"] {
        assert!(
            firefox
                .get(key)
                .and_then(|value| value.as_str())
                .is_some_and(|value| !value.is_empty()),
            "Firefox metadata is missing {key}"
        );
    }
    assert_eq!(
        firefox.get("version").and_then(|value| value.as_str()),
        Some("152.0.4-beta.30"),
        "Firefox metadata must use the approved runtime version"
    );
    let firefox_executable = firefox
        .get("executable")
        .and_then(|value| value.as_str())
        .expect("Firefox metadata is missing executable");
    assert!(
        !firefox_executable.starts_with('/')
            && !firefox_executable.starts_with('\\')
            && !firefox_executable.contains(':')
            && firefox_executable
                .split(['/', '\\'])
                .all(|component| !component.is_empty() && component != "." && component != "..")
            && firefox_executable.split(['/', '\\']).next_back()
                == Some(if windows {
                    "aliasmode.exe"
                } else {
                    "aliasmode"
                }),
        "Firefox metadata executable path is unsafe"
    );
    for key in ["sha256", "archiveSha256"] {
        let sha256 = firefox
            .get(key)
            .and_then(|value| value.as_str())
            .expect("Firefox metadata is missing hash");
        assert!(
            sha256.len() == 64
                && sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
                && sha256.bytes().any(|byte| byte != b'0'),
            "Firefox metadata has an invalid {key}"
        );
    }

    let out = PathBuf::from(env::var("OUT_DIR").expect("build output directory"));
    fs::write(out.join("browser.json"), metadata).expect("write embedded browser metadata");
}
