import { ButtonLink } from '@backstage/ui';
import { useEntity } from '@backstage/plugin-catalog-react';
import { DAAS_TEAM_ANNOTATION, teamNameFor } from '../entity';
import { useLinks } from '../routes';
import { TeamDetail } from './TeamsPage';
import { EmptyState, Mono } from './ui';

/** The "Deployments" tab on a Group: that team's stages, clusters, apps and deployments in DAAS. */
export function EntityTeamContent() {
  const { entity } = useEntity();
  const links = useLinks();
  const name = teamNameFor(entity);
  const onboard = links.onboardTeam();
  return (
    <div className="daas">
      <TeamDetail
        name={name}
        embedded
        notFound={
          <EmptyState
            title={`${entity.metadata.title ?? entity.metadata.name} isn’t onboarded to DAAS`}
            action={
              onboard && (
                <ButtonLink href={onboard} variant="primary" size="small">
                  Onboard the team
                </ButtonLink>
              )
            }
          >
            No DAAS team called <Mono>{name}</Mono>. If it has a different name there, add{' '}
            <Mono>{`${DAAS_TEAM_ANNOTATION}: <team>`}</Mono> to this Group.
          </EmptyState>
        }
      />
    </div>
  );
}

export default EntityTeamContent;
