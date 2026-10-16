(* Bench simulation. With SimEnable = TRUE the routine 01_Simulation.st plays the
   role of the field: it answers the outputs with feedbacks and moves the level. *)
VAR_GLOBAL
    SimEnable : BOOL := TRUE;
    SimLevel : REAL := 50.0;           (* simulated tank level, % *)
    SimInflowRate : REAL := 4.0;       (* % per second while the pump runs *)
    SimOutflowRate : REAL := 3.0;      (* % per second while the valve is open *)
    SimScanSeconds : REAL := 0.01;     (* must match interval_ms in plc.toml *)
END_VAR
