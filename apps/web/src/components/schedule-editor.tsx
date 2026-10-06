"use client";
import { Plus, Trash2 } from "lucide-react";
import type { Schedule } from "@/lib/types";
import { Button, Field, IconButton, Notice } from "./ui";
import { overrideDescription, overrideMode, setOverrideMode, type OverrideMode } from "@/lib/schedules";
import { SchedulePreview } from "./schedule-preview";
export const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export function ScheduleEditor({ value, onChange }: { value: Schedule; onChange: (schedule: Schedule) => void }) {
  const updateWindows = (day: number, windows: Schedule["windows"]) => onChange({ ...value, windows: [...value.windows.filter(window => window.day !== day), ...windows] });
  return <div className="stack"><div className="form-grid"><Field label="Availability"><select value={value.mode} onChange={event => onChange({ ...value, mode: event.target.value as Schedule["mode"] })}><option value="ALWAYS">Always, when the worker is ready</option><option value="WEEKLY">Weekly schedule</option><option value="MANUAL">Manually unavailable</option></select></Field><Field label="Timezone" hint="An IANA timezone; daylight-saving changes are applied automatically."><input value={value.timezone} onChange={event => onChange({ ...value, timezone: event.target.value })} placeholder="Europe/Zurich" list="timezones" /><datalist id="timezones">{["UTC", "Europe/Zurich", "Europe/London", "America/New_York", "America/Los_Angeles", "Asia/Tokyo", "Asia/Singapore", "Australia/Sydney"].map(zone => <option key={zone}>{zone}</option>)}</datalist></Field></div>
    {value.mode === "WEEKLY" && <><div className="schedule-days">{[1,2,3,4,5,6,0].map(day => {
      const windows = value.windows.filter(window => window.day === day);
      return <div className="schedule-day" key={day}><label className="checkbox-row"><input type="checkbox" checked={windows.length > 0} onChange={event => updateWindows(day, event.target.checked ? [{ day, start: "20:00", end: "07:00" }] : [])} />{days[day]}</label><div className="schedule-windows">{windows.map((window, index) => {
        const allDay = window.start === "00:00" && window.end === "24:00";
        function update(patch: Partial<typeof window>) { updateWindows(day, windows.map((item, i) => i === index ? { ...item, ...patch } : item)); }
        return <div className="schedule-window" key={index}><input type="time" aria-label={`${days[day]} start ${index + 1}`} disabled={allDay} value={window.start} onChange={event => update({ start: event.target.value })} /><span>to</span><input type="time" aria-label={`${days[day]} end ${index + 1}`} disabled={allDay} value={window.end === "24:00" ? "23:59" : window.end} onChange={event => update({ end: event.target.value })} /><label className="checkbox-row"><input type="checkbox" checked={allDay} onChange={event => update(event.target.checked ? { start: "00:00", end: "24:00" } : { start: "20:00", end: "07:00" })} />All day</label>{!allDay && window.end <= window.start && <small>Next day</small>}<IconButton label={`Remove ${days[day]} window ${index + 1}`} onClick={() => updateWindows(day, windows.filter((_, i) => i !== index))}><Trash2 size={14} /></IconButton></div>;
      })}{windows.length > 0 && windows.length < 4 && <button type="button" className="text-button" onClick={() => updateWindows(day, [...windows, { day, start: "09:00", end: "17:00" }])}><Plus size={13} />Add window</button>}{!windows.length && <span className="field-hint">Unavailable</span>}</div></div>;
    })}</div><Button className="align-start" onClick={() => { const monday = value.windows.filter(window => window.day === 1); onChange({ ...value, windows: [...value.windows.filter(window => ![2,3,4,5].includes(window.day)), ...[2,3,4,5].flatMap(day => monday.map(window => ({ ...window, day })))] }); }}>Copy Monday to weekdays</Button></>}
    <details><summary>Date overrides</summary><div className="stack">{value.overrides.map((override, index) => {
      const mode = overrideMode(override);
      const update = (patch: Partial<typeof override>) => onChange({ ...value, overrides: value.overrides.map((item, i) => i === index ? { ...item, ...patch } : item) });
      return <fieldset className="date-override" key={index}><legend>Override {index + 1}</legend><div className="form-grid">
        <Field label={`Date for override ${index + 1}`}><input type="date" value={override.date} required onChange={event => update({ date: event.target.value })} /></Field>
        <Field label={`Override ${index + 1} availability`}><select value={mode} onChange={event => onChange({ ...value, overrides: value.overrides.map((item, i) => i === index ? setOverrideMode(item, event.target.value as OverrideMode) : item) })}><option value="UNAVAILABLE">Unavailable</option><option value="ALL_DAY">Available all day</option><option value="TIMED">Available during a time window</option></select></Field>
        {mode === "TIMED" && <><Field label={`Override ${index + 1} start`}><input type="time" value={override.start ?? "00:00"} required onChange={event => update({ start: event.target.value })} /></Field>
          <Field label={`Override ${index + 1} end`}><input type="time" value={override.end === "24:00" ? "" : override.end ?? "17:00"} disabled={override.end === "24:00"} required onChange={event => update({ end: event.target.value })} /></Field>
          <label className="checkbox-row"><input type="checkbox" checked={override.end === "24:00"} onChange={event => update({ end: event.target.checked ? "24:00" : "17:00" })} />End at midnight</label></>}
      </div><div className="row between wrap"><p className="small muted">{overrideDescription(override)} / {value.timezone}</p><IconButton label={`Remove date override ${index + 1}`} onClick={() => onChange({ ...value, overrides: value.overrides.filter((_, i) => i !== index) })}><Trash2 size={15} /></IconButton></div></fieldset>;
    })}<Button disabled={value.overrides.length >= 365} onClick={() => onChange({ ...value, overrides: [...value.overrides, { date: "", available: false }] })}><Plus size={15} />Add date override</Button></div></details>
    <SchedulePreview value={value} />
    <Notice>Running jobs continue when a window closes. Queued jobs wait for an allowed window. Worker readiness and manual pause always take precedence.</Notice>
  </div>;
}
