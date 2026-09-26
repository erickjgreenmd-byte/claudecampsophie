import { useCallback, useEffect, useId, useState } from 'react';
import { Link } from 'react-router';
import { z } from 'zod';
import { childSubjectsResponseSchema } from '@pencillift/contracts';
import { PracticeSetsSection } from '../../components/learning/PracticeSetsSection.tsx';
import { ScheduleSection } from '../../components/learning/ScheduleSection.tsx';
import { SkillsSection } from '../../components/learning/SkillsSection.tsx';
import { StudyMaterialSection } from '../../components/learning/StudyMaterialSection.tsx';
import { SubjectsSection } from '../../components/learning/SubjectsSection.tsx';
import { TestDatesSection } from '../../components/learning/TestDatesSection.tsx';
import { EmptyState, ErrorState, Loading } from '../../components/states.tsx';
import { RequireParent, useApiQuery } from '../../lib/session.tsx';
import { childPickerSuffix } from './ChildrenPage.tsx';

/**
 * Parent learning planner (spec P7, P8, P10, P14 "learning trends, practice/review planner";
 * AC_LEARNING_01..10, AC_UX_02). One child at a time: subjects, the daily-practice and weekly
 * review schedule in the family's time zone, test dates, teacher lists and notes, the skill
 * dashboard, and practice sets with a PIN-protected answer key. No sibling comparison.
 */
export default function LearningPlannerPage() {
  return (
    <RequireParent>
      <LearningPlanner />
    </RequireParent>
  );
}

// Only the fields this page needs from GET /v1/family (owned by the family vertical); unknown keys
// are ignored rather than rendered.
const familySchema = z.object({
  timezone: z.string(),
  children: z.array(z.object({ id: z.uuid(), nickname: z.string(), status: z.string() })),
});
type PlannerChild = z.infer<typeof familySchema>['children'][number];

function LearningPlanner() {
  const family = useApiQuery((api) => api.get('/v1/family', familySchema), []);
  const children = family.status === 'ready' ? family.data.children : [];
  const [childId, setChildId] = useState<string | null>(null);
  const firstChild = children[0]?.id ?? null;
  useEffect(() => {
    if (childId === null && firstChild !== null) setChildId(firstChild);
  }, [childId, firstChild]);
  const selectId = useId();
  const child = children.find((c) => c.id === childId) ?? null;

  return (
    <>
      <h1>Learning planner</h1>
      <p>
        Plan daily practice and the weekly review, add test dates and class material, and see how
        each child is doing on their own terms. Children are never compared with each other.
      </p>
      {family.status === 'loading' ? <Loading label="Loading your family…" /> : null}
      {family.status === 'error' ? (
        <ErrorState
          message={
            family.error.code === 'NOT_FOUND'
              ? 'Create your family first, then come back to plan practice.'
              : family.error.message
          }
          onRetry={family.reload}
        />
      ) : null}
      {family.status === 'ready' && children.length === 0 ? (
        <EmptyState title="No children yet">
          <p>
            Add a child on the <Link to="/app/children">Children page</Link> to plan their practice.
          </p>
        </EmptyState>
      ) : null}
      {family.status === 'ready' && child !== null ? (
        <>
          <label htmlFor={selectId}>Child</label>
          <select id={selectId} value={child.id} onChange={(e) => setChildId(e.target.value)}>
            {children.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nickname}
                {childPickerSuffix(c)}
              </option>
            ))}
          </select>
          <ChildPlanner key={child.id} child={child} zone={family.data.timezone} />
        </>
      ) : null}
    </>
  );
}

function ChildPlanner({ child, zone }: { child: PlannerChild; zone: string }) {
  const subjectsPath = `/v1/children/${encodeURIComponent(child.id)}/subjects`;
  const subjects = useApiQuery(
    (api) => api.get(subjectsPath, childSubjectsResponseSchema),
    [subjectsPath],
  );
  // Bumped after subject or test-date changes so the schedule's upcoming releases refresh.
  const [scheduleKey, setScheduleKey] = useState(0);
  const { reload } = subjects;
  const subjectsChanged = useCallback(() => {
    reload();
    setScheduleKey((k) => k + 1);
  }, [reload]);
  const testDatesChanged = useCallback(() => setScheduleKey((k) => k + 1), []);
  const [list, setList] = useState<z.infer<typeof childSubjectsResponseSchema>['subjects'] | null>(
    null,
  );
  const ready = subjects.status === 'ready' ? subjects.data.subjects : null;
  useEffect(() => {
    if (ready) setList(ready);
  }, [ready]);
  const current = ready ?? list;

  return (
    <div aria-label={`Learning plan for ${child.nickname}`} role="region">
      <h2 style={{ marginTop: 24 }}>{child.nickname}</h2>
      {/*
        WEBR4-10: an archived child has no slot waiting to be bought — the profile is history only —
        so "doesn't have a paid slot yet … see Subscription" was both false and unactionable for it.
        A draft still gets that copy, because a draft really is waiting for a slot.
      */}
      {child.status === 'active' ? null : child.status === 'archived' ? (
        <p className="notice">
          {child.nickname}’s profile is archived, so no new practice is prepared and nothing here is
          released to them. What was planned and practised stays readable.{' '}
          <Link to="/app/children">
            Activate {child.nickname} again on the Children page while a paid slot is free
          </Link>
          .
        </p>
      ) : (
        <p className="notice">
          {child.nickname} doesn’t have a paid slot yet, so no practice is prepared. You can still
          set things up; see <Link to="/app/subscription">Subscription</Link>.
        </p>
      )}
      {current === null && subjects.status === 'loading' ? (
        <Loading label="Loading subjects…" />
      ) : null}
      {subjects.status === 'error' ? (
        <ErrorState
          message={`We couldn’t load ${child.nickname}’s subjects. ${subjects.error.message}`}
          onRetry={reload}
        />
      ) : null}
      {current !== null ? (
        <>
          <SubjectsSection
            childId={child.id}
            childName={child.nickname}
            subjects={current}
            onChanged={subjectsChanged}
          />
          <ScheduleSection
            childId={child.id}
            childName={child.nickname}
            subjects={current}
            refreshKey={scheduleKey}
          />
          <TestDatesSection
            childId={child.id}
            childName={child.nickname}
            subjects={current}
            onChanged={testDatesChanged}
          />
          <StudyMaterialSection childId={child.id} childName={child.nickname} subjects={current} />
          <SkillsSection
            childId={child.id}
            childName={child.nickname}
            subjects={current}
            zone={zone}
          />
          <PracticeSetsSection
            childId={child.id}
            childName={child.nickname}
            subjects={current}
            zone={zone}
          />
        </>
      ) : null}
    </div>
  );
}
