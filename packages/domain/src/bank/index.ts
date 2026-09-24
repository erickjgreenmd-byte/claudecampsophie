// Original question/template bank (spec P7): parameterized, validated items for the six subjects,
// teacher spelling lists and parent passages, an honest coverage report, and the grading and
// leak-guard helpers the API uses for practice answers. Pure and deterministic (seeded).
export {
  BANK_MAX_GRADE,
  BANK_MIN_GRADE,
  BANK_SUBJECTS,
  ORIGINAL_LICENSE,
  isBankSubject,
  type AnswerSpec,
  type AnswerSpecKind,
  type BankCategory,
  type BankItem,
  type BankSubject,
  type ChildPrompt,
  type ItemSource,
  type ResponseFormat,
  type WordProblemContext,
} from './types.ts';
export { pick, randInt, seededRandom, shortHash, shuffle } from './random.ts';
export { choiceLetters, gradeBankAnswer, keyAnswerText, protectedAnswersFor } from './grade.ts';
export {
  BANK_VALIDATION_ERROR_CODES,
  MAX_CHOICE_LENGTH,
  MAX_PASSAGE_LENGTH,
  MAX_PROMPT_TEXT_LENGTH,
  keepValid,
  validateBankItem,
  type BankValidationErrorCode,
} from './validate.ts';
export {
  SKILLS,
  bankGrade,
  bankSkillFor,
  matchSkills,
  prerequisiteMap,
  skillDefinition,
  skillLabel,
  skillsForGrade,
  skillsForSubject,
  type SkillDefinition,
} from './skills.ts';
export {
  DEFAULT_CONTEXTS,
  MATH_GENERATORS,
  WORD_PROBLEM_TEMPLATES,
  renderWordProblem,
  type GenContext,
  type WordProblemTemplate,
} from './math.ts';
export { GRAMMAR_GENERATORS } from './grammar.ts';
export {
  MAX_PARENT_PASSAGE_LENGTH,
  PASSAGES,
  parentPassageItems,
  passageItems,
} from './reading.ts';
export {
  FALLBACK_WORDS,
  MAX_SPELLING_LIST_WORDS,
  SPELLING_GENERATORS,
  acceptedVariants,
  misspellings,
  missingLetterPattern,
  parseSpellingList,
  teacherWordItems,
} from './spelling.ts';
export { SCIENCE_ITEMS, SOCIAL_STUDIES_ITEMS, factItems, type FactItem } from './facts.ts';
export {
  generateCandidates,
  generateSkillItems,
  gradeSkills,
  hasGenerator,
  subjectGrade,
  isKnownSkill,
  type CandidateOptions,
  type FamilyMaterial,
} from './generate.ts';
export {
  GENERAL_UNSUPPORTED,
  UNSUPPORTED_NICHES,
  bankCoverage,
  type BankCoverage,
  type CoverageSkill,
  type SubjectCoverage,
} from './coverage.ts';
export { rethemeWordProblem, validateContext } from './context.ts';
export {
  SPACED_REVIEW_AFTER_DAYS,
  interleaveBySubject,
  mapEventsToBankSkills,
  planDailySkills,
  planReviewSkills,
  summarizeBySubject,
  type DailySkillPlan,
  type ReviewSkillPlan,
} from './plan.ts';
