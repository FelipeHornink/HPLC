(* Open/close valve with Auto/Manual command, permissive and limit switch supervision. *)
FUNCTION_BLOCK FB_Valve
VAR_INPUT
    AutoCmd : BOOL;
    ManualCmd : BOOL;
    ManualMode : BOOL;
    Permissive : BOOL;         (* FALSE forces the valve closed *)
    OpenFeedback : BOOL;       (* open limit switch *)
    Reset : BOOL;
END_VAR
VAR_OUTPUT
    Open : BOOL;               (* drives the solenoid output *)
    IsOpen : BOOL;
    Fault : BOOL;              (* commanded open but limit switch not reached within 3 s *)
END_VAR
VAR
    TravelTimer : TON;
END_VAR

IF Reset THEN
    Fault := FALSE;
END_IF;
IF ManualMode THEN
    Open := ManualCmd AND Permissive AND NOT Fault;
ELSE
    Open := AutoCmd AND Permissive AND NOT Fault;
END_IF;
TravelTimer(IN := Open AND NOT OpenFeedback, PT := T#3s);
IF TravelTimer.Q THEN
    Fault := TRUE;
END_IF;
IsOpen := OpenFeedback;
END_FUNCTION_BLOCK
