(* On/off pump with Auto/Manual command, permissive and feedback supervision. *)
FUNCTION_BLOCK FB_Pump
VAR_INPUT
    AutoCmd : BOOL;            (* command from the state machine *)
    ManualCmd : BOOL;          (* command from the HMI in Manual mode *)
    ManualMode : BOOL;
    Permissive : BOOL;         (* FALSE forces the pump off *)
    Feedback : BOOL;           (* running feedback from the field *)
    Reset : BOOL;              (* clears a latched fault *)
END_VAR
VAR_OUTPUT
    Run : BOOL;                (* drives the contactor output *)
    Running : BOOL;
    Fault : BOOL;              (* commanded but no feedback within 2 s *)
END_VAR
VAR
    FeedbackTimer : TON;
END_VAR

IF Reset THEN
    Fault := FALSE;
END_IF;
IF ManualMode THEN
    Run := ManualCmd AND Permissive AND NOT Fault;
ELSE
    Run := AutoCmd AND Permissive AND NOT Fault;
END_IF;
FeedbackTimer(IN := Run AND NOT Feedback, PT := T#2s);
IF FeedbackTimer.Q THEN
    Fault := TRUE;
END_IF;
Running := Run AND Feedback;
END_FUNCTION_BLOCK
