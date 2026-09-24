import { useId } from 'react';
import {
  skillsResponseSchema,
  type ChildSubject,
  type SkillSummaryDto,
  type SkillsResponse,
} from '@pencillift/contracts';
import { useApiQuery } from '../../lib/session.tsx';
import { ErrorState, Loading } from '../states.tsx';
import { hintStyle, listReset, rowStyle, sectionStyle } from './feedback.tsx';
import { formatInZone, percent, questionsLabel, subjectName, subjectOrder } from './format.ts';

/** Minimum distinct independent questions before a skill gets a status (spec P7, AC_LEARNING_02). */
const EVIDENCE_MINIMUM = 5;

const GROUPS: readonly { status: SkillSummaryDto['status']; title: string }[] = [
  { status: 'strong', title: 'Strengths' },
  { status: 'needs_practice', title: 'Practice areas' },
  { status: 'developing', title: 'Developing' },
  { status: 'not_enough_evidence', title: 'Not enough evidence yet' },
];

/**
 * Skill evidence for ONE child (spec P7, P10; AC_LEARNING_01/02). First unaided tries and
 * completion after help or retries are shown separately; fewer than five distinct independent
 * questions reads "Not enough evidence"; nothing is ever called "mastered"; no other child is
 * shown or compared. "Needs practice" is a learning signal, not a diagnosis.
 */
export function SkillsSection({
  childId,
  childName,
  subjects,
  zone,
}: {
  childId: string;
  childName: string;
  subjects: readonly ChildSubject[];
  zone: string;
}) {
  const path = `/v1/children/${encodeURIComponent(childId)}/skills`;
  const query = useApiQuery((api) => api.get(path, skillsResponseSchema), [path]);
  const headingId = useId();

  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>{childName}’s skills</h2>
      <p>
        <strong>“Needs practice” is a learning signal, not a diagnosis.</strong> It says which
        skills to practice next — nothing about ability, attention or learning differences. This is
        not a test score.
      </p>
      {query.status === 'loading' ? <Loading label="Loading skills…" /> : null}
      {query.status === 'error' ? (
        <ErrorState
          message={`We couldn’t load ${childName}’s skills. ${query.error.message}`}
          onRetry={query.reload}
        />
      ) : null}
      {query.status === 'ready' ? (
        <SkillsBody data={query.data} childName={childName} subjects={subjects} zone={zone} />
      ) : null}
    </section>
  );
}

function SkillsBody({
  data,
  childName,
  subjects,
  zone,
}: {
  data: SkillsResponse;
  childName: string;
  subjects: readonly ChildSubject[];
  zone: string;
}) {
  const bySubject = new Map<string, SkillSummaryDto[]>();
  for (const skill of data.skills) {
    bySubject.set(skill.subjectKey, [...(bySubject.get(skill.subjectKey) ?? []), skill]);
  }
  const subjectKeys = [...bySubject.keys()].sort(subjectOrder);
  return (
    <>
      <p style={hintStyle}>{data.evidenceRule}</p>
      {subjectKeys.length === 0 ? (
        <p>
          No practice answers yet. As {childName} practices, skills appear here. Each one shows “Not
          enough evidence” until {childName} has answered at least {EVIDENCE_MINIMUM} different
          questions on it without help.
        </p>
      ) : null}
      {subjectKeys.map((key) => {
        const skills = bySubject.get(key) ?? [];
        const name = subjectName(key, subjects);
        return (
          <section key={key} aria-label={`${name} skills`} style={{ marginTop: 16 }}>
            <h3>{name}</h3>
            {GROUPS.map((group) => {
              const inGroup = skills.filter((s) => s.status === group.status);
              if (inGroup.length === 0) return null;
              return (
                <div key={group.status}>
                  <h4 style={{ margin: '12px 0 4px' }}>{group.title}</h4>
                  <ul style={listReset}>
                    {inGroup.map((s) => (
                      <SkillRow key={s.skill} skill={s} zone={zone} />
                    ))}
                  </ul>
                </div>
              );
            })}
          </section>
        );
      })}
      <details style={{ marginTop: 16 }}>
        <summary>What PencilLift can practice at {childName}’s grade</summary>
        {data.coverage.subjects.map((s) => (
          <div key={s.subjectKey}>
            <h4 style={{ margin: '12px 0 4px' }}>{subjectName(s.subjectKey, subjects)}</h4>
            <p style={{ margin: 0 }}>
              {s.supportedSkills.length > 0
                ? `Practiced: ${s.supportedSkills.map((k) => k.label).join(', ')}.`
                : 'No generated practice at this grade yet.'}
            </p>
            {s.unsupported.length > 0 ? (
              <p style={hintStyle}>Not covered yet: {s.unsupported.join('; ')}.</p>
            ) : null}
          </div>
        ))}
        {data.coverage.general.length > 0 ? (
          <ul>
            {data.coverage.general.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}
      </details>
    </>
  );
}

function SkillRow({ skill, zone }: { skill: SkillSummaryDto; zone: string }) {
  const thin = skill.status === 'not_enough_evidence';
  return (
    <li style={rowStyle} aria-label={`${skill.label}: ${skill.statusLabel}`}>
      <strong>{skill.label}</strong> — {skill.statusLabel}
      <dl style={{ margin: '4px 0 0', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 4 }}>
        <dt>First try, without help:</dt>
        <dd style={{ margin: 0 }}>{percent(skill.initialAccuracy)}</dd>
        <dt>Finished after help or retries:</dt>
        <dd style={{ margin: 0 }}>{percent(skill.eventualCompletionRate)}</dd>
        <dt>Evidence:</dt>
        <dd style={{ margin: 0 }}>
          {questionsLabel(skill.distinctIndependentQuestions)} answered independently
          {thin
            ? ` (${EVIDENCE_MINIMUM} needed before a status is shown)`
            : ` of ${questionsLabel(skill.distinctQuestions)} practiced`}
        </dd>
        {skill.lastPracticedAt ? (
          <>
            <dt>Last practiced:</dt>
            <dd style={{ margin: 0 }}>{formatInZone(skill.lastPracticedAt, zone)}</dd>
          </>
        ) : null}
      </dl>
    </li>
  );
}
