import { HttpResponse } from './types';
import { api } from './api';
import { SquidResponse } from '../../lib/api';

export async function setProduction(squidName: string, versionName: string): Promise<SquidResponse> {
  const { body } = await api<HttpResponse<SquidResponse>>( {
    method: 'put',
    path: `/aliases/squid/${squidName}/versions/${versionName}/prod`,
  });

  return body.payload
}
