(* Routine 2 - logic. This is the place to write your own program. *)

(* Start/stop: Stop comes from the HMI or from the normally closed button. *)
Motor(Start := StartEdge.Q, Stop := HmiStop OR NOT StopButton);
MotorRunning := Motor.Running;

(* Count the starts. *)
RunEdge(CLK := MotorRunning);
IF RunEdge.Q THEN
    StartCount := StartCount + 1;
END_IF;

(* Run-time counter: one tick per second while the motor runs. *)
SecondTimer(IN := MotorRunning AND NOT SecondTimer.Q, PT := T#1S);
IF SecondTimer.Q THEN
    RunSeconds := RunSeconds + 1;
END_IF;

(* Free-running blink, 1 Hz. *)
BlinkTimer(IN := NOT BlinkTimer.Q, PT := T#500MS);
IF BlinkTimer.Q THEN
    Blink := NOT Blink;
END_IF;
