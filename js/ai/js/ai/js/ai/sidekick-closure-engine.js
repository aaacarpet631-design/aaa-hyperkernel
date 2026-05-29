window.AAA_SIDEKICK_CLOSURE = {
    async auditJobFile(jobId) {
        const jobRes = await window.AAA_LOCAL_FIRST_STORAGE.get("jobs", jobId);
        const job = jobRes.data ?? jobRes.value;
        if (!job) return { ok: false, error: "JOB_NOT_FOUND" };

        const mediaRes = await window.AAA_LOCAL_FIRST_STORAGE.getAll("mediaCache");
        const allMedia = mediaRes.data ?? mediaRes.value ?? [];
        
        const jobMedia = allMedia.filter(m => m.jobId === jobId);
        const hasBefore = jobMedia.some(m => m.photoType === 'BEFORE');
        const hasAfter = jobMedia.some(m => m.photoType === 'AFTER');

        const hasEstimate = !!job.appliedEstimate || !!job.price;
        const hasNotes = Array.isArray(job.logs) && job.logs.length > 0;

        const autoVerified = {
            photos: hasBefore && hasAfter,
            estimate: hasEstimate,
            notes: hasNotes,
            sync: true // Placeholder until Sync Engine is fully implemented
        };

        const missingAuto = [];
        if (!autoVerified.photos) missingAuto.push("BEFORE_OR_AFTER_PHOTOS");
        if (!autoVerified.estimate) missingAuto.push("APPLIED_ESTIMATE");
        if (!autoVerified.notes) missingAuto.push("WORK_NOTES");

        return { 
            ok: true, 
            ready: missingAuto.length === 0, 
            autoVerified, 
            missingAuto 
        };
    },

    async safeCloseJob(jobId) {
        const res = await window.AAA_LOCAL_FIRST_STORAGE.get("jobs", jobId);
        const job = res.data ?? res.value;
        if (!job) return { ok: false, error: "JOB_NOT_FOUND" };

        const timestamp = window.AAA_RUNTIME_CLOCK.nowISO();
        job.currentState = "CLOSED";
        job.updatedAt = timestamp;

        await window.AAA_LOCAL_FIRST_STORAGE.put("jobs", jobId, job);

        const mutation = {
            mutationId: window.AAA_ID_FACTORY.createId("mut", []),
            entityId: jobId,
            entityType: "job",
            operation: "STATE_CHANGE",
            payload: { currentState: "CLOSED" },
            timestamp: timestamp,
            syncStatus: "PENDING"
        };
        await window.AAA_LOCAL_FIRST_STORAGE.put("mutationQueue", mutation.mutationId, mutation);

        return { ok: true, job };
    }
};
