# My first PLC

A small working program to start from: a motor with start/stop, a run-time counter, a
start counter and a blinking lamp.

| Where | What |
|---|---|
| `programs/Main.st` | the program, which pulls in the routines in order |
| `routines/02_Logic.st` | **write your own logic here** |
| `blocks/` | reusable function blocks (`FB_StartStop`) |
| `globals/` | inputs, outputs and HMI variables |
| `panel/panel.json`, `panel/pid.json` | HMI and P&ID screens (or use **Edit screen**) |
| `tests/scenarios.yaml` | automatic tests (**HPLC: Run test scenarios**) |

Press **Play**, then **Start** on the HMI. Change the code and press **Play** again to
rebuild.
