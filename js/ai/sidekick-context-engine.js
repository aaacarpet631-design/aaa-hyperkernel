window.AAA_SIDEKICK_CONTEXT = {
    async pollArrival(currentJobs) {
        if (!navigator.geolocation) {
            return { ok: false, error: "GEOLOCATION_UNAVAILABLE" };
        }

        const activeJobs = currentJobs.filter(j => j.currentState === 'QUOTE_OPEN' || j.currentState === 'SCHEDULED');
        if (activeJobs.length === 0) return { ok: false, status: "NO_ACTIVE_JOBS" };

        try {
            const pos = await this.getCurrentPositionSafe();
            const { latitude, longitude } = pos.coords;

            for (const job of activeJobs) {
                if (!job.latitude || !job.longitude) continue;
                
                const distanceMeters = this.haversineDistanceMeters(
                    latitude, longitude, 
                    job.latitude, job.longitude
                );

                // 200 meters = street-level proximity
                if (distanceMeters <= 200) {
                    return { ok: true, job, distanceMeters };
                }
            }
            return { ok: false, status: "NOT_AT_SITE" };
        } catch (err) {
            return { ok: false, error: "GEOLOCATION_DENIED_OR_FAILED" };
        }
    },

    getCurrentPositionSafe() {
        return new Promise((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(resolve, reject, {
                enableHighAccuracy: true,
                timeout: 5000,
                maximumAge: 0
            });
        });
    },

    haversineDistanceMeters(lat1, lon1, lat2, lon2) {
        const R = 6371e3; // Earth radius in meters
        const rad = Math.PI / 180;
        const dLat = (lat2 - lat1) * rad;
        const dLon = (lon2 - lon1) * rad;
        
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(lat1 * rad) * Math.cos(lat2 * rad) *
                  Math.sin(dLon / 2) * Math.sin(dLon / 2);
                  
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }
};
