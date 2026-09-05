import { type Request, type Response } from 'express';

import {
  AdvertiserContactSchema,
  CreateAdvertiserRequestSchema,
  UpdateAdvertiserRequestSchema,
} from '../../contracts/advertisers';
import { IdParamSchema } from '../../contracts/common';
import { currentUser } from '../../shared/http/middleware/auth';
import { parseBody, parseParams } from '../../shared/http/validate';

import * as advertisers from './advertisers.service';

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(req, CreateAdvertiserRequestSchema);
  const actor = currentUser(req).user;

  const created = await advertisers.createAdvertiser({
    ...body,
    user: body.user ?? null,
    createdBy: actor.id,
    // Named in the email, so the customer's first message is from a person at
    // MoveAd rather than from a system.
    createdByName: actor.fullName,
    ip: req.ip ?? null,
  });

  res.status(201).json(created);
}

export async function list(_req: Request, res: Response): Promise<void> {
  res.json(await advertisers.listAdvertisers());
}

export async function update(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  const changes = parseBody(req, UpdateAdvertiserRequestSchema);
  const actor = currentUser(req).user;

  res.json(
    await advertisers.updateAdvertiser({
      advertiserId: id,
      changes,
      actorUserId: actor.id,
      ip: req.ip ?? null,
    }),
  );
}

export async function createUser(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  const body = parseBody(req, AdvertiserContactSchema);
  const actor = currentUser(req).user;

  const created = await advertisers.createAdvertiserUser({
    advertiserId: id,
    ...body,
    createdBy: actor.id,
    createdByName: actor.fullName,
    ip: req.ip ?? null,
  });

  res.status(201).json(created);
}
