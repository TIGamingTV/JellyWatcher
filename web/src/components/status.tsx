import { Bookmark, Check, CheckCheck, Clock, Hourglass, Loader, PlayCircle, Library, XCircle, HelpCircle, CircleDot, type LucideIcon } from 'lucide-react';
import { REQUEST_STATE_LABEL, STAGE_LABEL, AVAILABILITY_LABEL, VIEWING_LABEL, type LifecycleStage, type RequestState, type AvailabilityState, type ViewingState } from '../../../shared/status';

export const STAGE_ICON: Record<LifecycleStage, LucideIcon> = {
  watched: CheckCheck,
  in_progress: PlayCircle,
  in_library: Library,
  reported_available: Check,
  partially_available: CircleDot,
  processing: Loader,
  pending_approval: Hourglass,
  requested: Clock,
  declined: XCircle,
  failed: XCircle,
  listed: Bookmark,
  unknown: HelpCircle,
};

const STAGE_PILL: Record<LifecycleStage, string> = {
  watched: '',
  in_progress: 'pill-green',
  in_library: 'pill-green',
  reported_available: 'pill-green',
  partially_available: 'pill-green',
  processing: 'pill-blue',
  pending_approval: 'pill-orange',
  requested: 'pill-orange',
  declined: 'pill-red',
  failed: 'pill-red',
  listed: '',
  unknown: '',
};

export function StagePill({ stage }: { stage: LifecycleStage }) {
  const Icon = STAGE_ICON[stage];
  return (
    <span className={`pill ${STAGE_PILL[stage]}`}>
      <Icon size={12} aria-hidden />
      {STAGE_LABEL[stage]}
    </span>
  );
}

const REQUEST_PILL: Record<RequestState, string> = {
  not_requested: '',
  submitted: 'pill-orange',
  pending_approval: 'pill-orange',
  approved: 'pill-blue',
  processing: 'pill-blue',
  partially_available: 'pill-green',
  available: 'pill-green',
  declined: 'pill-red',
  failed: 'pill-red',
  blocklisted: 'pill-red',
  unknown: '',
};
const REQUEST_ICON: Record<RequestState, LucideIcon> = {
  not_requested: Bookmark,
  submitted: Clock,
  pending_approval: Hourglass,
  approved: Check,
  processing: Loader,
  partially_available: CircleDot,
  available: Check,
  declined: XCircle,
  failed: XCircle,
  blocklisted: XCircle,
  unknown: HelpCircle,
};

export function RequestPill({ state }: { state: RequestState }) {
  const Icon = REQUEST_ICON[state];
  return (
    <span className={`pill ${REQUEST_PILL[state]}`}>
      <Icon size={12} aria-hidden />
      {REQUEST_STATE_LABEL[state]}
    </span>
  );
}

export function availabilityLabel(a: AvailabilityState) {
  return AVAILABILITY_LABEL[a];
}
export function viewingLabel(v: ViewingState) {
  return VIEWING_LABEL[v];
}
