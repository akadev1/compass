import React from 'react';
import { connect } from 'react-redux';
import {
  css,
  spacing,
  WorkspaceContainer,
  SpinLoaderWithLabel,
  ConfirmationModalArea,
} from '@mongodb-js/compass-components';
import type { RootState, ShardingStatus } from '../store/reducer';
import { ShardingStatuses } from '../store/reducer';
import UnshardedState from './states/unsharded';
import ShardingState from './states/sharding';
import ShardKeyCorrect from './states/shard-key-correct';
import ShardKeyInvalid from './states/shard-key-invalid';
import ShardKeyMismatch from './states/shard-key-mismatch';
import ShardingError from './states/sharding-error';

const containerStyles = css({
  paddingLeft: spacing[400],
  paddingRight: spacing[400],
  display: 'flex',
  width: '100%',
  height: '100%',
  maxWidth: '700px',
});

const workspaceContentStyles = css({
  paddingTop: spacing[400],
});

const centeredContent = css({
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  height: '100%',
});

type GlobalWritesProps = {
  shardingStatus: ShardingStatus;
};

function ShardingStateView({
  shardingStatus,
}: {
  shardingStatus: ShardingStatus;
}) {
  if (shardingStatus === ShardingStatuses.NOT_READY) {
    return (
      <div className={centeredContent}>
        <SpinLoaderWithLabel progressText="Loading …" />
      </div>
    );
  }

  if (
    shardingStatus === ShardingStatuses.UNSHARDED ||
    shardingStatus === ShardingStatuses.SUBMITTING_FOR_SHARDING
  ) {
    return <UnshardedState />;
  }

  if (
    shardingStatus === ShardingStatuses.SHARDING ||
    shardingStatus === ShardingStatuses.CANCELLING_SHARDING
  ) {
    return <ShardingState />;
  }

  if (
    shardingStatus === ShardingStatuses.SHARDING_ERROR ||
    shardingStatus === ShardingStatuses.CANCELLING_SHARDING_ERROR ||
    shardingStatus === ShardingStatuses.SUBMITTING_FOR_SHARDING_ERROR
  ) {
    return <ShardingError />;
  }

  if (
    shardingStatus === ShardingStatuses.SHARD_KEY_CORRECT ||
    shardingStatus === ShardingStatuses.UNMANAGING_NAMESPACE
  ) {
    return <ShardKeyCorrect />;
  }

  if (shardingStatus === ShardingStatuses.SHARD_KEY_INVALID) {
    return <ShardKeyInvalid />;
  }

  if (
    shardingStatus === ShardingStatuses.SHARD_KEY_MISMATCH ||
    shardingStatus === ShardingStatuses.UNMANAGING_NAMESPACE_MISMATCH
  ) {
    return <ShardKeyMismatch />;
  }

  return null;
}

export function GlobalWrites({ shardingStatus }: GlobalWritesProps) {
  return (
    <div className={containerStyles}>
      <WorkspaceContainer className={workspaceContentStyles}>
        <ConfirmationModalArea>
          <ShardingStateView shardingStatus={shardingStatus} />
        </ConfirmationModalArea>
      </WorkspaceContainer>
    </div>
  );
}
export default connect((state: RootState) => ({
  shardingStatus: state.status,
}))(GlobalWrites);
