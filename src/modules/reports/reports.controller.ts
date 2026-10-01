import { type Request, type Response } from 'express';

import { IdParamSchema } from '../../contracts/common';
import { ExportReportRequestSchema } from '../../contracts/reports';
import { ForbiddenError } from '../../shared/errors';
import { currentUser } from '../../shared/http/middleware/auth';
import { parseBody, parseParams } from '../../shared/http/validate';

import * as reports from './reports.service';

function advertiserIdOf(req: Request): string {
  const { user } = currentUser(req);
  if (!user.advertiserId) {
    throw new ForbiddenError('Only an advertiser account can export reports here.');
  }
  return user.advertiserId;
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(req, ExportReportRequestSchema);
  res.status(201).json(
    await reports.exportForAdvertiser({
      advertiserId: advertiserIdOf(req),
      campaignId: body.campaignId,
      type: body.type,
      range: { from: body.from, to: body.to },
    }),
  );
}

export async function list(req: Request, res: Response): Promise<void> {
  res.json(await reports.listForAdvertiser(advertiserIdOf(req)));
}

export async function download(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  const file = await reports.downloadForAdvertiser(advertiserIdOf(req), id);

  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(file.bytes);
}
