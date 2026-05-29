window.AAA_SIDEKICK_VOICE = {
    async startListening(jobId) {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            return { ok: false, error: "SPEECH_RECOGNITION_UNSUPPORTED" };
        }

        return new Promise((resolve) => {
            const recognition = new SpeechRecognition();
            recognition.continuous = false;
            recognition.interimResults = false;
            recognition.lang = 'en-US';

            recognition.onresult = async (event) => {
                const text = event.results[0][0].transcript;
                const saveRes = await this.saveTextLog(jobId, text);
                resolve(saveRes);
            };

            recognition.onerror = (event) => {
                resolve({ ok: false, error: event.error.toUpperCase() });
            };

            recognition.start();
        });
    },

    async saveTextLog(jobId, text) {
        if (!text || text.trim() === "") return { ok: false, error: "EMPTY_NOTE" };

        const res = await window.AAA_LOCAL_FIRST_STORAGE.get("jobs", jobId);
        const job = res.data ?? res.value;
        if (!job) return { ok: false, error: "JOB_NOT_FOUND" };

        const timestamp = window.AAA_RUNTIME_CLOCK.nowISO();
        const logEntry = {
            logId: window.AAA_ID_FACTORY.createId("log", [timestamp]),
            timestamp: timestamp,
            text: text.trim(),
            type: "VOICE_LOG"
        };

        // Append to local array securely
        job.logs = job.logs || [];
        job.logs.push(logEntry);
        job.updatedAt = timestamp;

        await window.AAA_LOCAL_FIRST_STORAGE.put("jobs", jobId, job);

        // Queue mutation for offline-first sync
        const mutation = {
            mutationId: window.AAA_ID_FACTORY.createId("mut", []),
            entityId: jobId,
            entityType: "job",
            operation: "APPEND_LOG",
            payload: logEntry,
            timestamp: timestamp,
            syncStatus: "PENDING"
        };
        await window.AAA_LOCAL_FIRST_STORAGE.put("mutationQueue", mutation.mutationId, mutation);

        return { ok: true, text: text.trim(), logId: logEntry.logId };
    }
};
