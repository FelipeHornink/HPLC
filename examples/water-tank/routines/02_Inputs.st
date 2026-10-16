(* Routine 2 - input scaling and operator mode. *)
Level := INT_TO_REAL(Analog.LevelRaw) / 100.0;
IF Level < 0.0 THEN
    Level := 0.0;
END_IF;
IF Level > 100.0 THEN
    Level := 100.0;
END_IF;
Status.AutoMode := Inputs.AutoSelector;
