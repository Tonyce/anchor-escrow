import * as anchor from "@project-serum/anchor";
import { Program } from "@project-serum/anchor";
import NodeWallet from "@project-serum/anchor/dist/cjs/nodewallet";
import { AnchorEscrow } from "../target/types/anchor_escrow";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  Connection,
  Commitment,
} from "@solana/web3.js";
import {
  getAccount,
  TOKEN_PROGRAM_ID,
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
  Account,
  createAssociatedTokenAccount,
} from "@solana/spl-token";
import { assert } from "chai";

describe("anchor-escrow", () => {
  const commitment: Commitment = "processed";
  // const connection = new Connection("https://rpc-mainnet-fork.dappio.xyz", {
  //   commitment,
  //   wsEndpoint: "wss://rpc-mainnet-fork.dappio.xyz/ws",
  // });
  const options = anchor.AnchorProvider.defaultOptions();
  const wallet = NodeWallet.local();
  const provider = anchor.AnchorProvider.env();
  const { connection } = provider;
  anchor.setProvider(provider);

  const program = anchor.workspace.AnchorEscrow as Program<AnchorEscrow>;

  let mintA: PublicKey;
  let mintB: PublicKey;
  let initializerTokenAccountA: Account;
  let initializerTokenAccountB: Account;
  let takerTokenAccountA: Account;
  let takerTokenAccountB: Account;
  let vault_account_pda: PublicKey;
  let vault_account_bump: number;
  let vault_authority_pda: PublicKey;

  const takerAmount = 1000;
  const initializerAmount = 500;

  const escrowAccount = anchor.web3.Keypair.generate();
  const payer = anchor.web3.Keypair.generate();
  const mintAuthority = anchor.web3.Keypair.generate();
  const initializerMainAccount = anchor.web3.Keypair.generate();
  const takerMainAccount = anchor.web3.Keypair.generate();

  it("Initialize program state", async () => {
    // Airdropping tokens to a payer.

    await connection.confirmTransaction(
      await connection.requestAirdrop(payer.publicKey, 1000000000),
      commitment
    );

    // Fund Main Accounts
    await provider.sendAndConfirm(
      (() => {
        const tx = new Transaction();
        tx.add(
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: initializerMainAccount.publicKey,
            lamports: 100000000,
          }),
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: takerMainAccount.publicKey,
            lamports: 100000000,
          })
        );
        return tx;
      })(),
      [payer]
    );
    const payerAccountInfo = await connection.getAccountInfo(payer.publicKey);
    // console.log(payerAccountInfo);
    const initializerMainAccountInfo = await connection.getAccountInfo(
      initializerMainAccount.publicKey
    );
    // console.log(initializerMainAccountInfo);
    const takerMainAccountInfo = await connection.getAccountInfo(
      takerMainAccount.publicKey
    );
    // console.log(takerMainAccountInfo);

    mintA = await createMint(
      connection,
      payer,
      mintAuthority.publicKey,
      null,
      0
    );

    mintB = await createMint(
      provider.connection,
      payer,
      mintAuthority.publicKey,
      null,
      0
    );

    // console.log({ mintA, mintB });

    initializerTokenAccountA = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mintA,
      initializerMainAccount.publicKey
    );
    takerTokenAccountA = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mintA,
      takerMainAccount.publicKey
    );

    initializerTokenAccountB = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mintB,
      initializerMainAccount.publicKey
    );
    takerTokenAccountB = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mintB,
      takerMainAccount.publicKey
    );

    // console.log({
    //   takerTokenAccountA,
    //   takerTokenAccountB,
    //   initializerTokenAccountA,
    //   initializerTokenAccountB,
    // });

    const mintAResult = await mintTo(
      connection,
      payer,
      mintA,
      initializerTokenAccountA.address,
      mintAuthority,
      initializerAmount,
      []
    );
    // console.log(mintAResult);

    const mintBResult = await mintTo(
      connection,
      takerMainAccount,
      mintB,
      takerTokenAccountB.address,
      mintAuthority,
      takerAmount,
      []
    );
    // console.log(mintBResult);

    let _initializerTokenAccountA = await getAccount(
      connection,
      initializerTokenAccountA.address
    );
    let _takerTokenAccountB = await getAccount(
      connection,
      takerTokenAccountB.address
    );

    assert.ok(Number(_initializerTokenAccountA.amount) == initializerAmount);
    assert.ok(Number(_takerTokenAccountB.amount) == takerAmount);
  });

  it("Initialize escrow", async () => {
    const [_vault_account_pda, _vault_account_bump] =
      await PublicKey.findProgramAddress(
        [Buffer.from(anchor.utils.bytes.utf8.encode("token-seed"))],
        program.programId
      );
    vault_account_pda = _vault_account_pda;
    vault_account_bump = _vault_account_bump;

    const [_vault_authority_pda, _vault_authority_bump] =
      await PublicKey.findProgramAddress(
        [Buffer.from(anchor.utils.bytes.utf8.encode("escrow"))],
        program.programId
      );
    vault_authority_pda = _vault_authority_pda;

    await program.methods
      .initialize(
        vault_account_bump,
        new anchor.BN(initializerAmount),
        new anchor.BN(takerAmount)
      )
      .accounts({
        initializer: initializerMainAccount.publicKey,
        vaultAccount: vault_account_pda,
        mint: mintA,
        initializerDepositTokenAccount: initializerTokenAccountA.address,
        initializerReceiveTokenAccount: initializerTokenAccountB.address,
        escrowAccount: escrowAccount.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions([
        await program.account.escrowAccount.createInstruction(escrowAccount),
      ])
      .signers([escrowAccount, initializerMainAccount])
      .rpc();

    let _vault = await getAccount(connection, vault_account_pda);

    let _escrowAccount = await program.account.escrowAccount.fetch(
      escrowAccount.publicKey
    );

    // Check that the new owner is the PDA.
    assert.ok(_vault.owner.equals(vault_authority_pda));

    // Check that the values in the escrow account match what we expect.
    assert.ok(
      _escrowAccount.initializerKey.equals(initializerMainAccount.publicKey)
    );
    assert.ok(_escrowAccount.initializerAmount.toNumber() == initializerAmount);
    assert.ok(_escrowAccount.takerAmount.toNumber() == takerAmount);
    assert.ok(
      _escrowAccount.initializerDepositTokenAccount.equals(
        initializerTokenAccountA.address
      )
    );
    assert.ok(
      _escrowAccount.initializerReceiveTokenAccount.equals(
        initializerTokenAccountB.address
      )
    );
  });

  it("Exchange escrow state", async () => {
    await program.methods
      .exchange()
      .accounts({
        taker: takerMainAccount.publicKey,
        takerDepositTokenAccount: takerTokenAccountB.address,
        takerReceiveTokenAccount: takerTokenAccountA.address,
        initializerDepositTokenAccount: initializerTokenAccountA.address,
        initializerReceiveTokenAccount: initializerTokenAccountB.address,
        initializer: initializerMainAccount.publicKey,
        escrowAccount: escrowAccount.publicKey,
        vaultAccount: vault_account_pda,
        vaultAuthority: vault_authority_pda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([takerMainAccount])
      .rpc();

    console.log("-----");

    let _takerTokenAccountA = await getAccount(
      connection,
      takerTokenAccountA.address
    );
    let _takerTokenAccountB = await getAccount(
      connection,
      takerTokenAccountB.address
    );
    let _initializerTokenAccountA = await getAccount(
      connection,
      initializerTokenAccountA.address
    );
    let _initializerTokenAccountB = await getAccount(
      connection,
      initializerTokenAccountB.address
    );

    assert.ok(Number(_takerTokenAccountA.amount) == initializerAmount);
    assert.ok(Number(_initializerTokenAccountA.amount) == 0);
    assert.ok(Number(_initializerTokenAccountB.amount) == takerAmount);
    assert.ok(Number(_takerTokenAccountB.amount) == 0);
  });

  it("Initialize escrow and cancel escrow", async () => {
    // Put back tokens into initializer token A account.
    await mintTo(
      connection,
      payer,
      mintA,
      initializerTokenAccountA.address,
      mintAuthority,
      initializerAmount,
      []
    );

    console.log("initialize");

    await program.methods
      .initialize(
        vault_account_bump,
        new anchor.BN(initializerAmount),
        new anchor.BN(takerAmount)
      )
      .accounts({
        initializer: initializerMainAccount.publicKey,
        vaultAccount: vault_account_pda,
        mint: mintA,
        initializerDepositTokenAccount: initializerTokenAccountA.address,
        initializerReceiveTokenAccount: initializerTokenAccountB.address,
        escrowAccount: escrowAccount.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions([
        await program.account.escrowAccount.createInstruction(escrowAccount),
      ])
      .signers([escrowAccount, initializerMainAccount])
      .rpc();

    console.log("cancel");
    // Cancel the escrow.
    await program.methods
      .cancel()
      .accounts({
        initializer: initializerMainAccount.publicKey,
        initializerDepositTokenAccount: initializerTokenAccountA.address,
        vaultAccount: vault_account_pda,
        vaultAuthority: vault_authority_pda,
        escrowAccount: escrowAccount.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([initializerMainAccount])
      .rpc();

    // Check the final owner should be the provider public key.
    const _initializerTokenAccountA = await getAccount(
      connection,
      initializerTokenAccountA.address
    );
    assert.ok(
      _initializerTokenAccountA.owner.equals(initializerMainAccount.publicKey)
    );

    // Check all the funds are still there.
    assert.ok(Number(_initializerTokenAccountA.amount) == initializerAmount);
  });
});
