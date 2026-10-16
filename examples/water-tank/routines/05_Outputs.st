(* Routine 5 - equipment objects and physical outputs. The alarms are
   interlocks in both modes: high level blocks the pump, low level blocks the valve. *)
Pump(AutoCmd := Status.State = 1,
     ManualCmd := Hmi.ManualPump,
     ManualMode := NOT Status.AutoMode,
     Permissive := NOT Status.HighAlarm,
     Feedback := Inputs.PumpFeedback,
     Reset := Hmi.ResetCmd);
Valve(AutoCmd := Status.State = 2,
      ManualCmd := Hmi.ManualValve,
      ManualMode := NOT Status.AutoMode,
      Permissive := NOT Status.LowAlarm,
      OpenFeedback := Inputs.ValveOpenFeedback,
      Reset := Hmi.ResetCmd);

Status.PumpRunning := Pump.Running;
Status.PumpFault := Pump.Fault;
Status.ValveIsOpen := Valve.IsOpen;
Status.ValveFault := Valve.Fault;

Outputs.PumpRun := Pump.Run;
Outputs.ValveOpen := Valve.Open;
Outputs.HighAlarmLamp := Status.HighAlarm;
Outputs.LowAlarmLamp := Status.LowAlarm;
