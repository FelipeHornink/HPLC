(* Starter project.
   Main runs every 10 ms (see plc.toml). Each @ROUTINE line pulls in a file from
   routines/ at that point, so the program reads from top to bottom.

   Try it: press Play, press Start on the HMI, then change routines/02_Logic.st
   (for example, stop the motor automatically after 10 s) and press Play again. *)
PROGRAM Main
VAR
    Motor : FB_StartStop;          (* start/stop latch, see blocks/ *)
    StartEdge : R_TRIG;            (* one pulse when Start is pressed *)
    RunEdge : R_TRIG;              (* one pulse when the motor starts *)
    SecondTimer : TON;             (* 1 s tick for the run-time counter *)
    BlinkTimer : TON;              (* 0.5 s tick for the blinking lamp *)
    Blink : BOOL;
END_VAR

(* @ROUTINE 01_Inputs.st *)
(* @ROUTINE 02_Logic.st *)
(* @ROUTINE 03_Outputs.st *)
END_PROGRAM
