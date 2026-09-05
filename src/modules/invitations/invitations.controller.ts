import { type Request, type Response } from 'express';

import { IdParamSchema } from '../../contracts/common';
import {
  AcceptInvitationRequestSchema,
  InvitationTokenParamSchema,
} from '../../contracts/invitations';
import { currentUser } from '../../shared/http/middleware/auth';
import { parseBody, parseParams } from '../../shared/http/validate';

import * as invitations from './invitations.service';

export async function show(req: Request, res: Response): Promise<void> {
  const { token } = parseParams(req, InvitationTokenParamSchema);
  res.json(await invitations.describe(token));
}

export async function accept(req: Request, res: Response): Promise<void> {
  const { token } = parseParams(req, InvitationTokenParamSchema);
  const { password } = parseBody(req, AcceptInvitationRequestSchema);

  res.json(await invitations.accept({ token, password, ip: req.ip ?? null }));
}

export async function resend(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  const actor = currentUser(req).user;

  res.json(
    await invitations.resend({
      userId: id,
      actorUserId: actor.id,
      actorName: actor.fullName,
      ip: req.ip ?? null,
    }),
  );
}
