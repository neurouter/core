import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { guard } from '@/app/route-guards';
import { ErrorState } from '@/components/feedback/states';
import { useSetCrumbs } from '@/components/layout/crumbs';
import { NeedGroupPanel } from '@/features/inbox/components';
import { needGroupQuery } from '@/features/inbox/queries';

export const Route = createFileRoute('/_app/inbox/needs/$groupId')({
  beforeLoad: guard(['inbox:read']),
  component: NeedPage,
});

function NeedPage() {
  const { groupId } = Route.useParams();
  const g = useQuery(needGroupQuery(groupId));
  useSetCrumbs([{ label: 'Inbox', to: '/inbox' }, { label: g.data?.label ?? 'Unmet need' }]);
  if (g.isError) return <ErrorState error={g.error} onRetry={() => void g.refetch()} />;
  return (
    <div className="max-w-3xl">
      <NeedGroupPanel groupId={groupId} heading="h1" />
    </div>
  );
}
