"""`bun run desktop` must create its Tauri resource before spawning (#1664)."""
import json
import subprocess
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
_LAUNCH = (_ROOT / "scripts" / "desktop-dev-launch.mjs").as_uri()


def test_desktop_dev_creates_dist_before_tauri_dev(tmp_path):
    cwd = tmp_path / "workspace" / "frontend"
    script = f"""
      import {{ launchTauriDev }} from {json.dumps(_LAUNCH)};
      const calls = [];
      const result = launchTauriDev({{
        cwd: {json.dumps(str(cwd))},
        args: ["--features", "test-feature"],
        env: {{ PATH: "test-path" }},
        mkdir: (path, options) => calls.push(["mkdir", path, options]),
        spawn: (command, args, options) => {{
          calls.push(["spawn", command, args, options]);
          return {{ status: 0 }};
        }},
      }});
      console.log(JSON.stringify({{ calls, result }}));
    """
    completed = subprocess.run(
        ["node", "--input-type=module", "--eval", script],
        check=True,
        capture_output=True,
        text=True,
    )
    observed = json.loads(completed.stdout)

    assert observed == {
        "calls": [
            ["mkdir", str(cwd / "dist"), {"recursive": True}],
            [
                "spawn",
                "bun",
                ["run", "tauri", "dev", "--features", "test-feature"],
                {"stdio": "inherit", "env": {"PATH": "test-path"}},
            ],
        ],
        "result": {"status": 0},
    }
