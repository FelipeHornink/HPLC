(* Routine 3 - level alarms with 1 % hysteresis. *)
IF Level >= HighAlarmLimit THEN
    Status.HighAlarm := TRUE;
ELSIF Level < HighAlarmLimit - 1.0 THEN
    Status.HighAlarm := FALSE;
END_IF;
IF Level <= LowAlarmLimit THEN
    Status.LowAlarm := TRUE;
ELSIF Level > LowAlarmLimit + 1.0 THEN
    Status.LowAlarm := FALSE;
END_IF;
