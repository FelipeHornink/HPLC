(* Operator commands and indications shown on the HMI page. *)
VAR_GLOBAL
    HmiStart : BOOL;               (* Start button on the HMI *)
    HmiStop : BOOL;                (* Stop button on the HMI *)
    MotorRunning : BOOL;           (* motor state shown to the operator *)
    RunSeconds : UDINT;            (* total motor run time, in seconds *)
    StartCount : UDINT;            (* how many times the motor started *)
END_VAR
