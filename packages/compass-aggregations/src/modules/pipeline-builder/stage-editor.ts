import type { Reducer } from 'redux';
import type { Document, MongoServerError } from 'mongodb';
import { isCancelError } from '../../utils/cancellable-promise';
import { RESTORE_PIPELINE } from '../saved-pipeline';
import type { PipelineBuilderThunkAction } from '../';
import { isAction } from '../../utils/is-action';
import type Stage from './stage';
import { CONFIRM_NEW } from '../import-pipeline';
import type { ENVS } from '@mongodb-js/mongodb-constants';
import { STAGE_OPERATORS } from '@mongodb-js/mongodb-constants';
import { DEFAULT_MAX_TIME_MS } from '../../constants';
import type { PreviewOptions } from './pipeline-preview-manager';
import {
  DEFAULT_PREVIEW_LIMIT,
  DEFAULT_SAMPLE_SIZE
} from './pipeline-preview-manager';

export const enum StageEditorActionTypes {
  StagePreviewFetch = 'compass-aggregations/pipeline-builder/stage-editor/StagePreviewFetch',
  StagePreviewFetchSuccess = 'compass-aggregations/pipeline-builder/stage-editor/StagePreviewFetchSuccess',
  StagePreviewFetchError = 'compass-aggregations/pipeline-builder/stage-editor/StagePreviewFetchError',
  StageValueChange = 'compass-aggregations/pipeline-builder/stage-editor/StageValueChange',
  StageOperatorChange = 'compass-aggregations/pipeline-builder/stage-editor/StageOperatorChange',
  StageCollapsedChange = 'compass-aggregations/pipeline-builder/stage-editor/StageCollapsedChange',
  StageDisabledChange = 'compass-aggregations/pipeline-builder/stage-editor/StageDisabledChange',
  StageAdded = 'compass-aggregations/pipeline-builder/stage-editor/StageAdded',
  StageRemoved = 'compass-aggregations/pipeline-builder/stage-editor/StageRemoved',
  StageMoved = 'compass-aggregations/pipeline-builder/stage-editor/StageMoved'
}

export type StagePreviewFetchAction = {
  type: StageEditorActionTypes.StagePreviewFetch;
  id: number;
};

export type StagePreviewFetchSuccessAction = {
  type: StageEditorActionTypes.StagePreviewFetchSuccess;
  id: number;
  previewDocs: Document[];
};

export type StagePreviewFetchErrorAction = {
  type: StageEditorActionTypes.StagePreviewFetchError;
  id: number;
  error: MongoServerError;
};

export type ChangeStageValueAction = {
  type: StageEditorActionTypes.StageValueChange;
  id: number;
  stage: Stage;
};

export type ChangeStageOperatorAction = {
  type: StageEditorActionTypes.StageOperatorChange;
  id: number;
  stage: Stage;
};

export type ChangeStageCollapsedAction = {
  type: StageEditorActionTypes.StageCollapsedChange;
  id: number;
  collapsed: boolean;
};

export type ChangeStageDisabledAction = {
  type: StageEditorActionTypes.StageDisabledChange;
  id: number;
  disabled: boolean;
};

export type StageAddAction = {
  type: StageEditorActionTypes.StageAdded;
  after?: number;
  stage: Stage;
};

export type StageRemoveAction = {
  type: StageEditorActionTypes.StageRemoved;
  at: number;
};

export type StageMoveAction = {
  type: StageEditorActionTypes.StageMoved;
  from: number;
  to: number;
};

function canRunStage(stage?: StageEditorState['stages'][number]): boolean {
  if (
    !stage ||
    stage.value == null ||
    stage.syntaxError ||
    !stage.stageOperator ||
    ['$out', '$merge'].includes(stage.stageOperator)
  ) {
    return false;
  }

  return true;
}

export const loadStagePreview = (
  idx: number
): PipelineBuilderThunkAction<
  Promise<void>,
  | StagePreviewFetchAction
  | StagePreviewFetchSuccessAction
  | StagePreviewFetchErrorAction
> => {
  return async (dispatch, getState, { pipelineBuilder }) => {
    const {
      pipelineBuilder: {
        stageEditor: { stages }
      },
      autoPreview
    } = getState();

    if (!autoPreview) {
      return;
    }

    if (stages[idx].disabled) {
      return;
    }

    if (
      // Only run stage if all previous ones are valid (otherwise it will fail
      // anyway)
      !stages.slice(0, idx + 1).every((stage) => {
        return canRunStage(stage);
      })
    ) {
      return;
    }

    try {
      dispatch({
        type: StageEditorActionTypes.StagePreviewFetch,
        id: idx
      });

      const {
        namespace,
        maxTimeMS,
        collationString,
        limit,
        largeLimit,
        inputDocuments
      } = getState();

      const options: PreviewOptions = {
        maxTimeMS: maxTimeMS ?? DEFAULT_MAX_TIME_MS,
        collation: collationString.value ?? undefined,
        sampleSize: largeLimit ?? DEFAULT_SAMPLE_SIZE,
        previewSize: limit ?? DEFAULT_PREVIEW_LIMIT,
        totalDocumentCount: inputDocuments.count
      };

      const previewDocs = await pipelineBuilder.getPreviewForStage(
        idx,
        namespace,
        options
      );
      dispatch({
        type: StageEditorActionTypes.StagePreviewFetchSuccess,
        id: idx,
        previewDocs
      });
    } catch (err) {
      if (isCancelError(err)) {
        return;
      }
      dispatch({
        type: StageEditorActionTypes.StagePreviewFetchError,
        id: idx,
        error: err as MongoServerError
      });
    }
  };
};

export const loadPreviewForStagesFrom = (
  from: number
): PipelineBuilderThunkAction<void> => {
  return (dispatch, getState) => {
    getState()
      .pipelineBuilder.stageEditor.stages.slice(from)
      .forEach((_, id) => {
        void dispatch(loadStagePreview(from + id));
      });
  };
};

export const changeStageValue = (
  id: number,
  newVal: string
): PipelineBuilderThunkAction<void, ChangeStageValueAction> => {
  return (dispatch, getState, { pipelineBuilder }) => {
    const stage = pipelineBuilder.getStage(id);
    if (!stage) {
      return;
    }
    stage.changeValue(newVal);
    dispatch({ type: StageEditorActionTypes.StageValueChange, id, stage });
    dispatch(loadPreviewForStagesFrom(id));
  };
};

const replaceOperatorSnippetTokens = (str: string): string => {
  const regex = /\${[0-9]+:?([a-z0-9.()]+)?}/gi;
  return str.replace(regex, function (_match, replaceWith) {
    return replaceWith ?? '';
  });
};

const ESCAPED_STAGE_OPERATORS = STAGE_OPERATORS.map((stage) => {
  return {
    ...stage,
    comment: replaceOperatorSnippetTokens(stage.comment),
    snippet: replaceOperatorSnippetTokens(stage.snippet)
  };
});

function getStageSnippet(
  stageOperator: string | null,
  env: string,
  shouldAddComment: boolean
) {
  const stage = ESCAPED_STAGE_OPERATORS.find((stageOp) => {
    return (
      stageOp.value === stageOperator &&
      (stageOp.env as readonly typeof ENVS[number][]).includes(
        env as typeof ENVS[number]
      )
    );
  });

  if (!stage) {
    return `{}`;
  }

  return [shouldAddComment && stage.comment, stage.snippet ?? `{}`]
    .filter(Boolean)
    .join('');
}

export const changeStageOperator = (
  id: number,
  newVal: string
): PipelineBuilderThunkAction<void, ChangeStageOperatorAction> => {
  return (dispatch, getState, { pipelineBuilder }) => {
    const stage = pipelineBuilder.getStage(id);

    if (!stage) {
      return;
    }

    if (stage.operator === newVal) {
      return;
    }

    const {
      env,
      comments,
      pipelineBuilder: {
        stageEditor: { stages }
      }
    } = getState();

    const currentSnippet = getStageSnippet(
      stages[id].stageOperator,
      env,
      comments
    );

    const currentOp = stage.operator;

    stage.changeOperator(newVal);
    dispatch({ type: StageEditorActionTypes.StageOperatorChange, id, stage });

    // If there is no stage operator (this is a newly added stage) or current
    // stage value is identical to the snippet for the current stage operator
    // change the stage value
    if (!currentOp || currentSnippet === stages[id].value) {
      const newValue = getStageSnippet(stage.operator, env, comments);
      dispatch(changeStageValue(id, newValue));
    }

    dispatch(loadPreviewForStagesFrom(id));
  };
};

export const changeStageDisabled = (
  id: number,
  newVal: boolean
): PipelineBuilderThunkAction<void, ChangeStageDisabledAction> => {
  return (dispatch, getState, { pipelineBuilder }) => {
    const stage = pipelineBuilder.getStage(id);
    if (!stage) {
      return;
    }
    stage.changeDisabled(newVal);
    dispatch({
      type: StageEditorActionTypes.StageDisabledChange,
      id,
      disabled: newVal
    });
    dispatch(loadPreviewForStagesFrom(id));
  };
};

export const changeStageCollapsed = (
  id: number,
  newVal: boolean
): ChangeStageCollapsedAction => {
  return {
    type: StageEditorActionTypes.StageCollapsedChange,
    id,
    collapsed: newVal
  };
};

export const addStage = (
  after?: number
): PipelineBuilderThunkAction<void, StageAddAction> => {
  return (dispatch, getState, { pipelineBuilder }) => {
    const stage = pipelineBuilder.addStage(after);
    dispatch({ type: StageEditorActionTypes.StageAdded, after, stage });
  };
};

export const removeStage = (
  at: number
): PipelineBuilderThunkAction<void, StageRemoveAction> => {
  return (dispatch, getState, { pipelineBuilder }) => {
    pipelineBuilder.removeStage(at);
    dispatch({ type: StageEditorActionTypes.StageRemoved, at });
    dispatch(loadPreviewForStagesFrom(at));
  };
};

export const moveStage = (
  from: number,
  to: number
): PipelineBuilderThunkAction<void, StageMoveAction> => {
  return (dispatch, getState, { pipelineBuilder }) => {
    if (from === to) {
      return;
    }
    pipelineBuilder.moveStage(from, to);
    dispatch({ type: StageEditorActionTypes.StageMoved, from, to });
    dispatch(loadPreviewForStagesFrom(Math.min(from, to)));
  };
};

export type StageEditorState = {
  stagesCount: number;
  stages: {
    stageOperator: string | null;
    value: string | null;
    syntaxError: SyntaxError | null;
    serverError: MongoServerError | null;
    loading: boolean;
    previewDocs: Document[] | null;
    collapsed: boolean;
    disabled: boolean;
  }[];
};

export function mapBuilderStageToStoreStage(
  stage: Stage
): StageEditorState['stages'][number] {
  return {
    stageOperator: stage.operator,
    value: stage.value,
    syntaxError: stage.syntaxError,
    disabled: stage.disabled,
    serverError: null,
    loading: false,
    previewDocs: null,
    collapsed: false
  };
}

const reducer: Reducer<StageEditorState> = (
  state = { stagesCount: 0, stages: [] },
  action
) => {
  if (action.type === RESTORE_PIPELINE || action.type === CONFIRM_NEW) {
    return {
      stagesCount: action.stages.length,
      stages: action.stages.map((stage: Stage) => {
        return mapBuilderStageToStoreStage(stage);
      })
    };
  }

  if (
    isAction<StagePreviewFetchAction>(
      action,
      StageEditorActionTypes.StagePreviewFetch
    )
  ) {
    return {
      ...state,
      stages: [
        ...state.stages.slice(0, action.id),
        {
          ...state.stages[action.id],
          loading: true
        },
        ...state.stages.slice(action.id + 1)
      ]
    };
  }

  if (
    isAction<StagePreviewFetchSuccessAction>(
      action,
      StageEditorActionTypes.StagePreviewFetchSuccess
    )
  ) {
    return {
      ...state,
      stages: [
        ...state.stages.slice(0, action.id),
        {
          ...state.stages[action.id],
          loading: false,
          previewDocs: action.previewDocs,
          serverError: null
        },
        ...state.stages.slice(action.id + 1)
      ]
    };
  }

  if (
    isAction<StagePreviewFetchErrorAction>(
      action,
      StageEditorActionTypes.StagePreviewFetchError
    )
  ) {
    return {
      ...state,
      stages: [
        ...state.stages.slice(0, action.id),
        {
          ...state.stages[action.id],
          loading: false,
          serverError: action.error
        },
        ...state.stages.slice(action.id + 1)
      ]
    };
  }

  if (
    isAction<ChangeStageValueAction>(
      action,
      StageEditorActionTypes.StageValueChange
    )
  ) {
    return {
      ...state,
      stages: [
        ...state.stages.slice(0, action.id),
        {
          ...state.stages[action.id],
          value: action.stage.value,
          syntaxError: action.stage.syntaxError
        },
        ...state.stages.slice(action.id + 1)
      ]
    };
  }

  if (
    isAction<ChangeStageOperatorAction>(
      action,
      StageEditorActionTypes.StageOperatorChange
    )
  ) {
    return {
      ...state,
      stages: [
        ...state.stages.slice(0, action.id),
        {
          ...state.stages[action.id],
          stageOperator: action.stage.operator,
          syntaxError: action.stage.syntaxError
        },
        ...state.stages.slice(action.id + 1)
      ]
    };
  }

  if (
    isAction<ChangeStageDisabledAction>(
      action,
      StageEditorActionTypes.StageDisabledChange
    )
  ) {
    return {
      ...state,
      stages: [
        ...state.stages.slice(0, action.id),
        {
          ...state.stages[action.id],
          disabled: action.disabled
        },
        ...state.stages.slice(action.id + 1)
      ]
    };
  }

  if (
    isAction<ChangeStageCollapsedAction>(
      action,
      StageEditorActionTypes.StageCollapsedChange
    )
  ) {
    return {
      ...state,
      stages: [
        ...state.stages.slice(0, action.id),
        {
          ...state.stages[action.id],
          collapsed: action.collapsed
        },
        ...state.stages.slice(action.id + 1)
      ]
    };
  }

  if (isAction<StageAddAction>(action, StageEditorActionTypes.StageAdded)) {
    const after = action.after ?? state.stages.length;
    const stages = [...state.stages];
    stages.splice(after + 1, 0, mapBuilderStageToStoreStage(action.stage));
    return {
      ...state,
      stagesCount: stages.length,
      stages
    };
  }

  if (
    isAction<StageRemoveAction>(action, StageEditorActionTypes.StageRemoved)
  ) {
    const stages = [...state.stages];
    stages.splice(action.at, 1);
    return {
      ...state,
      stagesCount: stages.length,
      stages
    };
  }

  if (isAction<StageMoveAction>(action, StageEditorActionTypes.StageMoved)) {
    const stages = [...state.stages];
    const movedStage = stages.splice(action.from, 1)[0];
    stages.splice(action.to, 0, movedStage);
    return {
      ...state,
      stages
    };
  }

  return state;
};

export default reducer;
