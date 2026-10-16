(* Data types of the water tank demo. *)
TYPE ST_DigitalInputs :
STRUCT
    StartButton : BOOL;        (* DI-00, momentary *)
    StopButton : BOOL;         (* DI-01, normally closed: FALSE = pressed *)
    AutoSelector : BOOL;       (* DI-02, TRUE = Auto, FALSE = Manual *)
    PumpFeedback : BOOL;       (* DI-03, contactor auxiliary contact *)
    ValveOpenFeedback : BOOL;  (* DI-04, valve open limit switch *)
END_STRUCT;
END_TYPE

TYPE ST_DigitalOutputs :
STRUCT
    PumpRun : BOOL;            (* DQ-00 *)
    ValveOpen : BOOL;          (* DQ-01 *)
    HighAlarmLamp : BOOL;      (* DQ-02 *)
    LowAlarmLamp : BOOL;       (* DQ-03 *)
END_STRUCT;
END_TYPE

TYPE ST_AnalogInputs :
STRUCT
    LevelRaw : INT;            (* AI-00, 0..10000 = 0..100.00 % *)
END_STRUCT;
END_TYPE

TYPE ST_HmiCommands :
STRUCT
    StartCmd : BOOL;           (* momentary *)
    StopCmd : BOOL;            (* momentary *)
    ResetCmd : BOOL;           (* momentary, acknowledges equipment faults *)
    ManualPump : BOOL;         (* Manual mode: pump command *)
    ManualValve : BOOL;        (* Manual mode: valve command *)
END_STRUCT;
END_TYPE

TYPE ST_TankStatus :
STRUCT
    State : INT;               (* 0 = Idle, 1 = Filling, 2 = Draining *)
    AutoMode : BOOL;
    Running : BOOL;            (* Auto cycle requested *)
    PumpRunning : BOOL;
    PumpFault : BOOL;
    ValveIsOpen : BOOL;
    ValveFault : BOOL;
    HighAlarm : BOOL;
    LowAlarm : BOOL;
END_STRUCT;
END_TYPE
