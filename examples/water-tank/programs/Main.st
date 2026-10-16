(* Water tank demo: one pump fills the tank, one valve drains it.
   The scan runs the routines below in this fixed order. *)
PROGRAM Main
VAR
    Pump : FB_Pump;
    Valve : FB_Valve;
    StartEdge : R_TRIG;
END_VAR

(* @ROUTINE 01_Simulation.st *)
(* @ROUTINE 02_Inputs.st *)
(* @ROUTINE 03_Alarms.st *)
(* @ROUTINE 04_StateMachine.st *)
(* @ROUTINE 05_Outputs.st *)
END_PROGRAM
