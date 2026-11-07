import { z } from 'zod';
import { DEFAULT_MATCH, DEFAULT_WATCHERS, STEPS_FOR_UNIT, STEP_LABEL, type JanitorRuleInput } from '../../shared/janitor.js';

const Step = z.discriminatedUnion('type', [
  z.object({ type: z.literal('wait'), days: z.number().int().min(0).max(3650), hours: z.number().int().min(0).max(23).default(0) }),
  z.object({ type: z.literal('notify'), message: z.string().trim().min(1).max(500) }),
  z.object({ type: z.literal('approval') }),
  z.object({ type: z.literal('gate'), condition: z.enum(['series_ended', 'no_files_left']), otherwise: z.enum(['stop', 'recheck']).default('stop') }),
  z.object({ type: z.literal('sonarr_delete_season'), unmonitor: z.boolean().default(true) }),
  z.object({ type: z.literal('sonarr_delete_series'), importListExclusion: z.boolean().default(false) }),
  z.object({ type: z.literal('radarr_delete_movie'), importExclusion: z.boolean().default(false) }),
  z.object({ type: z.literal('seerr_delete_request') }),
  z.object({ type: z.literal('seerr_delete_media') }),
]);

export const RuleInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean().default(false),
    mediaType: z.enum(['movie', 'tv']),
    unit: z.enum(['movie', 'season', 'series']),
    mode: z.enum(['dry_run', 'approval', 'auto']).default('dry_run'),
    match: z
      .object({
        requestedBy: z.array(z.number().int().positive()).max(500).default([]),
        is4k: z.enum(['any', 'yes', 'no']).default('any'),
        seriesStatus: z.enum(['any', 'ended', 'continuing']).default('any'),
      })
      .default({ ...DEFAULT_MATCH }),
    watchers: z
      .object({
        requester: z.enum(['required', 'ignored']).default('required'),
        others: z.enum(['none', 'active', 'watchlisted', 'active_or_watchlisted', 'all_linked']).default('none'),
        othersMode: z.enum(['all', 'at_least']).default('all'),
        atLeast: z.number().int().min(1).max(100).default(1),
        dropAfterDays: z.number().int().min(1).max(3650).nullable().default(null),
      })
      .default({ ...DEFAULT_WATCHERS }),
    steps: z.array(Step).max(30),
  })
  .superRefine((r, c) => {
    if ((r.mediaType === 'movie') !== (r.unit === 'movie')) c.addIssue({ code: 'custom', path: ['unit'], message: 'Movies are handled as a whole; shows by season or as a whole show.' });
    const allowed = STEPS_FOR_UNIT[r.unit];
    r.steps.forEach((s, i) => {
      if (!allowed.includes(s.type)) c.addIssue({ code: 'custom', path: ['steps', i], message: `“${STEP_LABEL[s.type]}” does not fit this kind of rule.` });
    });
    if (r.watchers.requester === 'ignored' && r.watchers.others === 'none') {
      c.addIssue({ code: 'custom', path: ['watchers'], message: 'Choose who has to watch it: the requester, other people, or both.' });
    }
    if (!r.steps.some((s) => s.type !== 'wait' && s.type !== 'notify' && s.type !== 'approval' && s.type !== 'gate')) {
      c.addIssue({ code: 'custom', path: ['steps'], message: 'Add at least one deletion step.' });
    }
  }) as unknown as z.ZodType<JanitorRuleInput>;
