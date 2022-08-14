import { setProduction } from '../../api/alias';
import { parseNameAndVersion } from '../../utils';
import { CliCommand } from '../../command';

export default class Prod extends CliCommand {
    static description = 'Promote version to production';
    static hidden = true;
    static deprecated = true;
    static args = [
        {
            name: 'nameAndVersion',
            description: 'name@version',
            required: true,
        },
    ];

    async run(): Promise<void> {
        const { args } = await this.parse(Prod);

        const { squidName, versionName } = parseNameAndVersion(
          args.nameAndVersion,
          this
        );

        const squid = await setProduction(squidName, versionName);

        this.log(`Your squid is promoted to production and will be accessible soon at ${squid.versions[0].deploymentUrl}.`)
    }
}
