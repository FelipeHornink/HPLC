(* Routine 1 - field model used only on the bench. Disable SimEnable to drive
   the inputs by hand from the panel. *)
IF SimEnable THEN
    Inputs.PumpFeedback := Outputs.PumpRun;
    Inputs.ValveOpenFeedback := Outputs.ValveOpen;
    IF Outputs.PumpRun THEN
        SimLevel := SimLevel + SimInflowRate * SimScanSeconds;
    END_IF;
    IF Outputs.ValveOpen THEN
        SimLevel := SimLevel - SimOutflowRate * SimScanSeconds;
    END_IF;
    IF SimLevel < 0.0 THEN
        SimLevel := 0.0;
    END_IF;
    IF SimLevel > 100.0 THEN
        SimLevel := 100.0;
    END_IF;
    Analog.LevelRaw := REAL_TO_INT(SimLevel * 100.0);
END_IF;
