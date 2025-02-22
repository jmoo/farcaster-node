import Faker from 'faker';
import Engine from '~/engine';
import { Factories } from '~/factories';
import {
  Cast,
  Ed25519Signer,
  EthereumSigner,
  IDRegistryEvent,
  MessageFactoryTransientParams,
  Reaction,
  SignerAdd,
} from '~/types';
import { generateEd25519Signer, generateEthereumSigner } from '~/utils';

const engine = new Engine();
const aliceFid = Faker.datatype.number();
const aliceAdds = () => engine._getReactionAdds(aliceFid);
const aliceCastAdds = () => engine._getCastAdds(aliceFid);

describe('mergeReaction', () => {
  let aliceCustody: EthereumSigner;
  let aliceCustodyRegister: IDRegistryEvent;
  let aliceSigner: Ed25519Signer;
  let aliceSignerAdd: SignerAdd;
  let cast: Cast;
  let reaction: Reaction;
  let transient: { transient: MessageFactoryTransientParams };

  beforeAll(async () => {
    aliceCustody = await generateEthereumSigner();
    aliceCustodyRegister = await Factories.IDRegistryEvent.create({
      args: { to: aliceCustody.signerKey, id: aliceFid },
      name: 'Register',
    });
    aliceSigner = await generateEd25519Signer();
    aliceSignerAdd = await Factories.SignerAdd.create(
      { data: { fid: aliceFid, body: { delegate: aliceSigner.signerKey } } },
      { transient: { signer: aliceCustody } }
    );
    transient = { transient: { signer: aliceSigner } };
    cast = await Factories.CastShort.create({ data: { fid: aliceFid } }, transient);
    reaction = await Factories.ReactionAdd.create({ data: { fid: aliceFid } }, transient);
  });

  beforeEach(async () => {
    engine._reset();
    await engine.mergeIDRegistryEvent(aliceCustodyRegister);
    await engine.mergeMessage(aliceSignerAdd);
  });

  test('handles invalid type cast', async () => {
    const invalidCastReaction = cast as unknown as Reaction;
    const result = await engine.mergeMessage(invalidCastReaction);
    expect(result.isOk()).toBeTruthy();
    expect(aliceAdds()).toEqual(new Set([]));
    expect(aliceCastAdds()).toEqual(new Set([invalidCastReaction]));
  });

  describe('signer validation', () => {
    test('fails if there are no known signers', async () => {
      engine._resetSigners();

      const result = await engine.mergeMessage(reaction);
      expect(result._unsafeUnwrapErr()).toBe('validateMessage: unknown user');
      expect(aliceAdds()).toEqual(new Set([]));
    });

    test('fails if the signer was not valid', async () => {
      // Calling Factory without specifying a signing key makes Faker choose a random one
      const reactionInvalidSigner = await Factories.ReactionAdd.create({
        data: {
          fid: aliceFid,
        },
      });

      const result = await engine.mergeMessage(reactionInvalidSigner);
      expect(result._unsafeUnwrapErr()).toBe('validateMessage: invalid signer');
      expect(aliceAdds()).toEqual(new Set([]));
    });

    test('fails if the signer was valid, but the fid was invalid', async () => {
      const unknownUser = await Factories.ReactionAdd.create({ data: { fid: aliceFid + 1 } }, transient);

      expect((await engine.mergeMessage(unknownUser))._unsafeUnwrapErr()).toBe('validateMessage: unknown user');
      expect(aliceAdds()).toEqual(new Set([]));
    });
  });

  describe('message validation', () => {
    test('fails if the hash is invalid', async () => {
      const invalidHash = JSON.parse(JSON.stringify(reaction)) as Reaction;
      invalidHash.hash = '0xd4126acebadb14b41943fc10599c00e2e3627f1e38672c8476277ecf17accb48';

      expect((await engine.mergeMessage(invalidHash))._unsafeUnwrapErr()).toBe('validateMessage: invalid hash');
      expect(aliceAdds()).toEqual(new Set([]));
    });

    test('fails if the signature is invalid', async () => {
      const invalidSignature = JSON.parse(JSON.stringify(reaction)) as Reaction;
      invalidSignature.signature =
        '0x5b699d494b515b22258c01ad19710d44c3f12235f0c01e91d09a1e4e2cd25d80c77026a7319906da3b8ce62abc18477c19e444a02949a0dde54f8cadef889502';
      expect((await engine.mergeMessage(invalidSignature))._unsafeUnwrapErr()).toBe(
        'validateMessage: invalid signature'
      );
      expect(aliceAdds()).toEqual(new Set([]));
    });

    test('fails if signedAt is > current time + safety margin', async () => {
      const elevenMinutesAhead = Date.now() + 11 * 60 * 1000;

      const futureReaction = await Factories.ReactionAdd.create(
        {
          data: {
            fid: aliceFid,

            signedAt: elevenMinutesAhead,
          },
        },
        transient
      );

      expect((await engine.mergeMessage(futureReaction))._unsafeUnwrapErr()).toEqual(
        'validateMessage: signedAt more than 10 mins in the future'
      );
    });
  });

  // test('fails if the schema is invalid', async () => {});
  test('fails if targetUri does not match schema', async () => {
    const invalidTargets: string[] = [
      'foobar.com', // URL missing scheme
      'farcaster://fid:1', // cannot react to a user
      'chain://eip155:1', // chain URLs not allowed (must be a resource on the chain)
    ];
    for (const invalidTarget of invalidTargets) {
      const invalidTargetUri = await Factories.ReactionAdd.create(
        {
          data: { body: { targetUri: invalidTarget }, fid: aliceFid },
        },
        transient
      );
      const result = await engine.mergeMessage(invalidTargetUri);
      expect(result.isOk()).toBe(false);
      expect(result._unsafeUnwrapErr()).toEqual('validateReaction: invalid URL for reaction target');
    }
  });
  test('fails if the type is invalid', async () => {
    const reactionInvalidType = await Factories.ReactionAdd.create(
      {
        data: {
          fid: aliceFid,

          body: {
            type: 'wrong' as unknown as any,
          },
        },
      },
      transient
    );
    const result = await engine.mergeMessage(reactionInvalidType);

    expect(result.isOk()).toBe(false);
    expect(result._unsafeUnwrapErr()).toBe('validateMessage: unknown message');
    expect(aliceAdds()).toEqual(new Set([]));
  });

  test('succeeds if a valid active reaction is added', async () => {
    expect((await engine.mergeMessage(reaction)).isOk()).toBe(true);
    expect(aliceAdds()).toEqual(new Set([reaction]));
  });
});
