# Equipment screen configuration

Edit `panel.json` with the command **HPLC: Configure Screen and Mapping**, or with
**Edit screen** on the bench page itself. The page reads this file when it opens;
the PLC does not need to be rebuilt. (Projects created by older versions use
`painel.json`; it is still read when `panel.json` does not exist.)

The bench has no preparation macro: each tag is commanded individually.
DI/AI inputs keep the written value until the user or the ST changes them.
DO/AO outputs also accept test writes, but the next program scan normally
overwrites them.

## Areas

- `monitoring`: top strip for operating states and internal variables.
- `hmi`: commands and values of the operator HMI clone (legacy key: `ihm`).
- `panel`: push buttons and switches of the panel door, including Local/Remote.
- `interface`: signals exchanged with the customer (hard-wired DCS commands, permissives).
- `field`: field DIs (limit switches, feedbacks), DO/AO of the equipment and the
  analog instruments.
- `communication`: Modbus map, generated at build from `modbus.toml` (legacy key: `comunicacao`).

Both spellings of the area keys are accepted; an existing project keeps the key
it already uses when the screen is saved.

## Widgets

- `momentary`: pulse button. While paused it stays pressed until the next scan or a new click.
- `toggle`: latched BOOL switch.
- `lamp`: read-only BOOL indication.
- `analog`: editable numeric value.
- `number`: numeric value, editable or read-only according to `writable`.

Items of the `hmi` area also accept `"tab": "Tab name"`, so one HMI can have
tabs such as Operation, Settings and Diagnostics without writing HTML.

Numeric items can use `"valueLabels": {"0":"Idle"}` to show an operating
description without changing the real value received from the PLC.

`display.realPrecision` sets the default number of decimal places for
`REAL/LREAL`. Each item can override it with `"precision": 1`, for example.
Formatting changes only the presentation; the PLC value is not rounded.
`display.theme` accepts `"light"` or `"dark"` as the initial theme, and the
user can switch it in the header.

Use `ioType` to tag the origin of a signal: `DI`, `DO`, `AI`, `AO`, `HMI`,
`INTERNAL`, `STATUS`... The `address` field shows the matching physical or
logical channel.

Example:

```json
{
  "tag": "Inputs.StartButton",
  "label": "Start push button",
  "kind": "momentary",
  "ioType": "DI",
  "address": "DI-00",
  "writable": true
}
```

## Per-point simulation

Each item can declare the simulation link of that point:

```json
{
  "tag": "Level",
  "label": "LT-100 level",
  "kind": "number",
  "writable": false,
  "simulation_flag": {
    "flag": "SimEnable",
    "value": "SimLevel"
  }
}
```

- `flag` — turns the simulation of **that** point on/off. The chip next to the
  label shows the state (`SIM` in the field, `SIMULATED` in the model) and **is
  the command**: clicking toggles it.
- `value` — what the operator edits while the point is simulated. On an input it
  is the value used instead of the channel; on an output it is the forced value.
- `readonly` — the chip only **announces** that the point is simulated, without
  commanding it. The monitoring area uses it: turning the simulation on or off
  belongs to the input area.

A simulable point (with `value` and without `readonly`) shows **both values side
by side** — the simulated one, chosen by the operator, and the physical/logical
one. The highlighted one is what the program is using at that moment.

An item without `simulation_flag` has no chip — nothing is guessed from the tag
name. In **Edit screen** mode both fields appear in the item properties, and the
*link simulation* button fills them from the project conventions
(`<object>.SimEnable` / `<object>.SimValue`, or the legacy
`<object>.HabilitaSimulacao` / `<object>.ValorSimulado`).

The `tag` must exist in **Live debugging**. If the program writes the same
variable every scan, the manual write is visible immediately and may then be
overwritten by the logic; use **Force** when it must be held.

## Simulation bar

The **Simulation** button shows the ST routine that models the field, with the
value each line writes. Choose the file and the master switch in `panel.json`:

```json
"simulation": {"source": "routines/01_Simulation.st", "enable": "SimEnable"}
```

Without this block the page falls back to the legacy defaults
(`routines/03_Simu.st` and `SimuAtiva`).

## P&ID view

`pid.html` is served on a separate port and `pid.json` lists the variables and
their percentage positions (`x` and `y`), plus the drawn `shapes` (valve, pump,
motor, vessel, pipe, label, lines, rectangles, ellipses). Use **Edit** on the
P&ID page to drag, resize and link tags visually instead of editing the JSON by hand.

## Language

Both pages are in English by default. The extension injects
`window.hplcLang = 'pt-BR'` to show them in Brazilian Portuguese.
