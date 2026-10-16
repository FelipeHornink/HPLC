(* Physical I/O image. Mapped to channels in io.toml. *)
VAR_GLOBAL
    Inputs : ST_DigitalInputs := (StopButton := TRUE, AutoSelector := TRUE);
    Outputs : ST_DigitalOutputs;
    Analog : ST_AnalogInputs;
END_VAR
