/*
 * AAA Scheduling — dispatch calendar built on real job data.
 *
 * Jobs already carry scheduledDate (ISO date or datetime), assigneeIds (crew),
 * and currentState. This module organizes them into day/week views, assigns
 * crew + a time window, and DETECTS CONFLICTS: a crew member double-booked in
 * overlapping windows on the same day. It never invents schedule data — a job
 * with no scheduledDate is "unscheduled", full stop.
 *
 * Writes (assign crew, set window) go through the Runtime Gateway (EDIT_JOB) in
 * the UI so they are RBAC-checked + audited.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }

  function dayKey(d) {
    if (!d) return null;
    const s = String(d);
    // Accept 'YYYY-MM-DD' or full ISO; take the date part.
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
    const dt = new Date(s);
    return isNaN(dt) ? null : dt.toISOString().slice(0, 10);
  }
  // Minutes-since-midnight for a job's window start; null when no time given.
  function startMins(job) {
    if (job.scheduledStartMins != null) return Number(job.scheduledStartMins);
    const s = String(job.scheduledDate || '');
    const m = s.match(/T(\d{2}):(\d{2})/);
    return m ? (Number(m[1]) * 60 + Number(m[2])) : null;
  }
  function duration(job) { return Number(job.durationMins) > 0 ? Number(job.durationMins) : 120; } // default 2h

  function overlaps(a, b) {
    const as = startMins(a), bs = startMins(b);
    if (as == null || bs == null) return false; // can't conflict without times
    const ae = as + duration(a), be = bs + duration(b);
    return as < be && bs < ae;
  }
  function sharedCrew(a, b) {
    const ax = Array.isArray(a.assigneeIds) ? a.assigneeIds : [];
    const bx = Array.isArray(b.assigneeIds) ? b.assigneeIds : [];
    return ax.filter((id) => bx.indexOf(id) !== -1);
  }

  const Sched = {
    /** All jobs grouped by day (scheduled only), plus an unscheduled bucket. */
    async calendar() {
      const jobs = (await data().listJobs()).filter((j) => j && j.currentState !== 'CLOSED');
      const days = {};
      const unscheduled = [];
      jobs.forEach((j) => {
        const k = dayKey(j.scheduledDate);
        if (!k) { unscheduled.push(j); return; }
        (days[k] = days[k] || []).push(j);
      });
      Object.keys(days).forEach((k) => days[k].sort((a, b) => (startMins(a) || 0) - (startMins(b) || 0)));
      return { days: days, unscheduled: unscheduled };
    },

    /** Jobs on a given day (YYYY-MM-DD), time-sorted. */
    async forDay(dateStr) {
      const cal = await this.calendar();
      return cal.days[dayKey(dateStr)] || [];
    },

    /** Next N days from today with their jobs. */
    async upcoming(days) {
      const cal = await this.calendar();
      const today = new Date((clock() && clock().now ? clock().now() : Date.now()));
      const out = [];
      for (let i = 0; i < (days || 7); i++) {
        const d = new Date(today.getTime() + i * 86400000);
        const k = d.toISOString().slice(0, 10);
        out.push({ date: k, jobs: cal.days[k] || [] });
      }
      return out;
    },

    /**
     * Conflicts for a day: pairs of jobs that share a crew member AND have
     * overlapping time windows. Returns [{ a, b, crew:[ids] }].
     */
    async conflictsForDay(dateStr) {
      const jobs = await this.forDay(dateStr);
      const out = [];
      for (let i = 0; i < jobs.length; i++) {
        for (let j = i + 1; j < jobs.length; j++) {
          const shared = sharedCrew(jobs[i], jobs[j]);
          if (shared.length && overlaps(jobs[i], jobs[j])) {
            out.push({ a: jobs[i], b: jobs[j], crew: shared });
          }
        }
      }
      return out;
    },

    /** All conflicts across the schedule, keyed by day. */
    async allConflicts() {
      const cal = await this.calendar();
      const result = {};
      for (const k of Object.keys(cal.days)) {
        const c = await this.conflictsForDay(k);
        if (c.length) result[k] = c;
      }
      return result;
    },

    /**
     * Would assigning `crewIds` to `job` create a conflict on its day?
     * Pure check — does not write. Used before committing an assignment.
     */
    async wouldConflict(job, crewIds) {
      if (!job || !job.scheduledDate) return { conflict: false };
      const sameDay = (await this.forDay(job.scheduledDate)).filter((j) => j.id !== job.id);
      const probe = Object.assign({}, job, { assigneeIds: crewIds || [] });
      for (const other of sameDay) {
        const shared = sharedCrew(probe, other);
        if (shared.length && overlaps(probe, other)) return { conflict: true, with: other, crew: shared };
      }
      return { conflict: false };
    },

    // expose helpers for UI/labels
    _dayKey: dayKey, _startMins: startMins, _duration: duration
  };

  global.AAA_SCHEDULING = Sched;
})(typeof window !== 'undefined' ? window : this);
