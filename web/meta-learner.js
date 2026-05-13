/**
 * Meta-Learner — Adaptive AI Behavior from User Feedback
 *
 * Analyzes thumbs-up/down ratings to build a user preference profile.
 * All data stays client-side in localStorage.
 */

const FEEDBACK_KEY = 'lse-feedback-log';
const PROFILE_KEY = 'lse-user-profile';
const BIAS_KEY = 'lse-model-bias';

export class MetaLearner {
  constructor() {
    /** @type {Array<{ nodeId: number, action: string, keyword: string, components: string[], rating: number, timestamp: number }>} */
    this.feedback = [];
    this.profile = this._defaultProfile();
    this._load();
  }

  _defaultProfile() {
    return {
      preferredDomains: [],
      preferredStyle: 'balanced', // 'concise' | 'poetic' | 'balanced'
      preferredLength: 5,
      preferredTier: 'STANDARD',
      domainScores: {},
      tierScores: { LITE: 0, STANDARD: 0, ULTRA: 0 },
      ratedCount: 0,
    };
  }

  _save() {
    try {
      localStorage.setItem(FEEDBACK_KEY, JSON.stringify(this.feedback.slice(-200)));
      localStorage.setItem(PROFILE_KEY, JSON.stringify(this.profile));
    } catch {}
  }

  _load() {
    try {
      const fb = localStorage.getItem(FEEDBACK_KEY);
      if (fb) this.feedback = JSON.parse(fb);
      const pf = localStorage.getItem(PROFILE_KEY);
      if (pf) this.profile = JSON.parse(pf);
    } catch {}
  }

  /** Record a rating event. */
  rate(nodeId, keyword, action, components, rating) {
    this.feedback.push({ nodeId, action, keyword, components, rating, timestamp: Date.now() });
    if (this.feedback.length > 200) this.feedback = this.feedback.slice(-200);
    this._updateProfile();
    this._save();
  }

  /** Analyze feedback and update the user profile. */
  _updateProfile() {
    const recent = this.feedback.slice(-50);
    if (recent.length < 5) return;

    const liked = recent.filter(f => f.rating > 0);
    const disliked = recent.filter(f => f.rating < 0);
    const allRated = [...liked, ...disliked];
    if (allRated.length < 3) return;

    // Preferred length: average component count from liked
    const likedLengths = liked.map(f => f.components?.length || 4);
    if (likedLengths.length > 0) {
      this.profile.preferredLength = Math.round(likedLengths.reduce((a, b) => a + b, 0) / likedLengths.length);
    }

    // Domain analysis: count keywords in each tier's domain
    const tiers = { LITE: 0, STANDARD: 0, ULTRA: 0 };
    let tierRated = 0;
    for (const f of allRated) {
      const tier = f.tier || 'STANDARD';
      tiers[tier] = (tiers[tier] || 0) + f.rating;
      tierRated++;
    }
    if (tierRated > 3) {
      this.profile.tierScores = tiers;
      // Auto-upgrade if LITE consistently negative
      if (tiers.LITE < -2 && tiers.STANDARD >= 0) this.profile.preferredTier = 'STANDARD';
      if (tiers.STANDARD > 2) this.profile.preferredTier = 'STANDARD';
    }

    // Style preference: check liked component names
    const allComponents = liked.flatMap(f => f.components || []);
    const longDescriptive = allComponents.filter(c => c.length > 12).length;
    const shortTerse = allComponents.filter(c => c.length <= 6).length;
    if (shortTerse > longDescriptive * 1.5) this.profile.preferredStyle = 'concise';
    else if (longDescriptive > shortTerse * 1.5) this.profile.preferredStyle = 'poetic';
    else this.profile.preferredStyle = 'balanced';

    this.profile.ratedCount = allRated.length;
    this._save();
  }

  /** Get the current user profile for injection into API calls. */
  getUserProfile() {
    const p = this.profile;
    if (p.ratedCount < 5) return null;
    return {
      preferredStyle: p.preferredStyle,
      preferredLength: p.preferredLength,
      preferredTier: p.preferredTier,
      tierScores: p.tierScores,
    };
  }

  /** Build a custom system prompt by injecting user preferences. */
  buildCustomPrompt(basePrompt, userProfile) {
    if (!userProfile) return basePrompt;
    let prompt = basePrompt;

    if (userProfile.preferredStyle === 'concise') {
      prompt += ' Use terse, precise technical terms. Keep component names short (1-2 words).';
    } else if (userProfile.preferredStyle === 'poetic') {
      prompt += ' Use evocative, metaphorical language. Component names can be descriptive phrases.';
    }

    if (userProfile.preferredLength) {
      prompt += ` Return exactly ${userProfile.preferredLength} components.`;
    }

    return prompt;
  }

  /** Get the model bias adjustment for routing. */
  getModelBias() {
    const scores = this.profile.tierScores;
    const total = scores.LITE + scores.STANDARD + scores.ULTRA;
    if (total === 0) return null;
    return {
      LITE: scores.LITE / (Math.abs(total) + 1),
      STANDARD: scores.STANDARD / (Math.abs(total) + 1),
      ULTRA: scores.ULTRA / (Math.abs(total) + 1),
    };
  }

  /** Reset all learning data. */
  reset() {
    this.feedback = [];
    this.profile = this._defaultProfile();
    try {
      localStorage.removeItem(FEEDBACK_KEY);
      localStorage.removeItem(PROFILE_KEY);
      localStorage.removeItem(BIAS_KEY);
    } catch {}
  }
}
