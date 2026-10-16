(* Physical inputs and outputs. On a real PLC they are wired to I/O cards; in HPLC you
   operate them on the HMI page, in the "Panel door" and "Signals and equipment" areas. *)
VAR_GLOBAL
    StartButton : BOOL;            (* DI-00 push button *)
    StopButton : BOOL := TRUE;     (* DI-01 normally closed: FALSE means pressed *)
    MotorContactor : BOOL;         (* DQ-00 motor contactor *)
    RunLamp : BOOL;                (* DQ-01 green lamp, on while the motor runs *)
    BlinkLamp : BOOL;              (* DQ-02 blinks while the motor is stopped *)
END_VAR
