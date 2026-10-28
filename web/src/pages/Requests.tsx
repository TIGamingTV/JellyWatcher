import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import type { RequestState } from '../../../shared/status';
import { errorText, get, post, qs } from '../lib/api';
import { useToast, useUser } from '../lib/session';
import type { TitleCard } from '../lib/types';
import { date } from '../lib/format';
import { Banner, CenterLoading, EmptyState, ErrorState, PageHeader, Segmented, SyncButton, Time } from '../components/ui';
import { PosterImage } from '../components/Poster';
import { RequestPill } from '../components/status';

interface RequestItem {
  id: number;
  titleId: number;
  requestedBy: string | null;
  userName: string | null;
  state: RequestState;
  seasons: number[];
  is4k: number;
  origin: string;
  lastError: string | null;
  createdAt: string;
  syncedAt: string | null;
  title: TitleCard | null;
  mine: boolean;
}

const EXPLAIN: Partial<Record<RequestState, string>> = {
  pending_approval: 'Waiting for an administrator to approve it in Seerr.',
  approved: 'Approved. Waiting for the download to start.',
  processing: 'Downloading or being imported.',
  partially_available: 'Some seasons or episodes are available.',
  available: 'Available. It shows as In Library once Jellyfin has it.',
  declined: 'Declined in Seerr. You can request it again from the title page.',
  failed: 'Seerr reported a failure. An administrator can retry it in Seerr.',
  unknown: 'This request no longer exists in Seerr, or its state is unknown.',
};

export function RequestsPage() {
  const { isAdmin, services, user } = useUser();
  const [filter, setFilter] = useState<'active' | 'available' | 'problems' | 'all'>('active');
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [syncing, setSyncing] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['requests', filter, scope], queryFn: () => get<{ items: RequestItem[]; seerr: { ready: boolean; lastOkAt: string | null; status: string } }>(`/requests${qs({ filter, scope })}`), refetchInterval: 60_000 });

  const sync = async () => {
    setSyncing(true);
    try {
      await post('/admin/sync/seerr');
      await new Promise((r) => setTimeout(r, 1200));
      await qc.invalidateQueries({ queryKey: ['requests'] });
    } catch (err) {
      toast('error', errorText(err));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Requests"
        subtitle={
          q.data?.seerr.ready ? (
            <>
              Status from Seerr, updated <Time iso={q.data.seerr.lastOkAt} />
              {q.data.seerr.status === 'error' && ' · the last update failed'}
            </>
          ) : undefined
        }
        actions={isAdmin && services.seerr ? <SyncButton busy={syncing} onClick={sync} label="Update from Seerr" /> : undefined}
      />
      {!services.seerr && (
        <Banner kind="warn" title="Seerr isn’t connected">
          {isAdmin ? 'Connect Seerr in Integrations to request titles and follow their progress.' : 'Ask an administrator to connect Seerr.'}
        </Banner>
      )}
      {services.seerr && !user.seerr && (
        <div style={{ marginBottom: 16 }}>
          <Banner kind="info" title="Your account isn’t linked to Seerr">
            {isAdmin ? (
              <>
                Link it in <Link to="/settings/users">Settings › Users</Link> to make requests.
              </>
            ) : (
              'Ask an administrator to link your account so you can make requests.'
            )}
          </Banner>
        </div>
      )}
      <div className="toolbar" style={{ marginBottom: 18 }}>
        <Segmented
          label="Filter requests"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'active', label: 'In Progress' },
            { value: 'available', label: 'Available' },
            { value: 'problems', label: 'Needs Attention' },
            { value: 'all', label: 'All' },
          ]}
        />
        {isAdmin && (
          <Segmented
            label="Whose requests"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'mine', label: 'Mine' },
              { value: 'all', label: 'Everyone' },
            ]}
          />
        )}
      </div>
      {q.isLoading ? (
        <CenterLoading />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.data!.items.length === 0 ? (
        <EmptyState icon={<Inbox size={26} />} title={filter === 'active' ? 'No Requests in Progress' : 'No Requests'} actions={<Link className="btn" to="/watchlists?availability=not_in_library&request=not_requested">Find Something to Request</Link>}>
          Requests you make here or directly in Seerr appear in this list.
        </EmptyState>
      ) : (
        <div className="group">
          {q.data!.items.map((r) => (
            <Link key={r.id} to={`/titles/${r.titleId}`} className="request-row">
              <div className="thumb">
                <PosterImage src={r.title?.posterUrl ?? null} alt="" fallback="" />
              </div>
              <div style={{ minWidth: 0 }}>
                <div className="row-title">
                  {r.title?.title ?? 'Unknown title'} {r.title?.year && <span className="secondary">({r.title.year})</span>}
                </div>
                <div className="row-sub">
                  {r.mine ? 'You' : (r.userName ?? r.requestedBy ?? 'Someone')} · {date(r.createdAt)}
                  {r.seasons.length > 0 && ` · Season${r.seasons.length > 1 ? 's' : ''} ${r.seasons.join(', ')}`}
                  {r.is4k ? ' · 4K' : ''}
                  {r.origin === 'seerr' && ' · made in Seerr'}
                </div>
                <div className="row-sub">{r.lastError ?? EXPLAIN[r.state]}</div>
              </div>
              <RequestPill state={r.state} />
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
