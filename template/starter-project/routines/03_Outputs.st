(* Routine 3 - outputs: drive the physical outputs from the logic. *)
MotorContactor := MotorRunning;
RunLamp := MotorRunning;
BlinkLamp := Blink AND NOT MotorRunning;
