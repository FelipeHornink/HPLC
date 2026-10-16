(* Operating limits. Editable from the HMI "Settings" tab. *)
VAR_GLOBAL
    FillTarget : REAL := 80.0;         (* Filling stops here and draining starts, % *)
    DrainTarget : REAL := 20.0;        (* Draining stops here and filling starts, % *)
    HighAlarmLimit : REAL := 95.0;     (* LAH, pump is blocked above it, % *)
    LowAlarmLimit : REAL := 5.0;       (* LAL, valve is blocked below it, % *)
END_VAR
