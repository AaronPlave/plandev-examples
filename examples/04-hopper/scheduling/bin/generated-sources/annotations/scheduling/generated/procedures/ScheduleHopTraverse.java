package scheduling.generated.procedures;

import gov.nasa.ammos.plandev.contrib.serialization.mappers.NullableValueMapper;
import gov.nasa.ammos.plandev.contrib.serialization.rulesets.BasicValueMappers;
import gov.nasa.ammos.plandev.merlin.framework.ValueMapper;
import gov.nasa.ammos.plandev.merlin.protocol.model.InputType;
import gov.nasa.ammos.plandev.merlin.protocol.types.Duration;
import gov.nasa.ammos.plandev.merlin.protocol.types.InstantiationException;
import gov.nasa.ammos.plandev.merlin.protocol.types.SerializedValue;
import gov.nasa.ammos.plandev.merlin.protocol.types.UnconstructableArgumentException;
import gov.nasa.ammos.plandev.merlin.protocol.types.ValueSchema;
import gov.nasa.ammos.plandev.procedural.scheduling.ProcedureMapper;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import scheduling.generated.AutoValueMappers;

public final class ScheduleHopTraverse implements ProcedureMapper<scheduling.procedures.ScheduleHopTraverse> {
  @Override
  public ValueSchema valueSchema() {
    return AutoValueMappers.scheduling_procedures_ScheduleHopTraverse(
            BasicValueMappers.string(),
            BasicValueMappers.string(),
            BasicValueMappers.duration(),
            BasicValueMappers.duration(),
            BasicValueMappers.duration()).getValueSchema();
  }

  @Override
  public InputType<scheduling.procedures.ScheduleHopTraverse> getInputType() {
    return new InputMapper();
  }

  public final class InputMapper implements InputType<scheduling.procedures.ScheduleHopTraverse> {
    private final ValueMapper<String> mapper_sites;

    private final ValueMapper<String> mapper_order;

    private final ValueMapper<Duration> mapper_startAfter;

    private final ValueMapper<Duration> mapper_restAfterHop;

    private final ValueMapper<Duration> mapper_pictureDuration;

    @SuppressWarnings("unchecked")
    public InputMapper() {
      this.mapper_sites =
          new NullableValueMapper<>(
              BasicValueMappers.string());
      this.mapper_order =
          new NullableValueMapper<>(
              BasicValueMappers.string());
      this.mapper_startAfter =
          new NullableValueMapper<>(
              BasicValueMappers.duration());
      this.mapper_restAfterHop =
          new NullableValueMapper<>(
              BasicValueMappers.duration());
      this.mapper_pictureDuration =
          new NullableValueMapper<>(
              BasicValueMappers.duration());
    }

    @Override
    public List<String> getRequiredParameters() {
      return List.of();
    }

    @Override
    public ArrayList<InputType.Parameter> getParameters() {
      final var parameters = new ArrayList<InputType.Parameter>();
      parameters.add(new InputType.Parameter("sites", this.mapper_sites.getValueSchema()));
      parameters.add(new InputType.Parameter("order", this.mapper_order.getValueSchema()));
      parameters.add(new InputType.Parameter("startAfter", this.mapper_startAfter.getValueSchema()));
      parameters.add(new InputType.Parameter("restAfterHop", this.mapper_restAfterHop.getValueSchema()));
      parameters.add(new InputType.Parameter("pictureDuration", this.mapper_pictureDuration.getValueSchema()));
      return parameters;
    }

    @Override
    public Map<String, SerializedValue> getArguments(
        final scheduling.procedures.ScheduleHopTraverse input) {
      final var arguments = new HashMap<String, SerializedValue>();
      arguments.put("sites", this.mapper_sites.serializeValue(input.sites()));
      arguments.put("order", this.mapper_order.serializeValue(input.order()));
      arguments.put("startAfter", this.mapper_startAfter.serializeValue(input.startAfter()));
      arguments.put("restAfterHop", this.mapper_restAfterHop.serializeValue(input.restAfterHop()));
      arguments.put("pictureDuration", this.mapper_pictureDuration.serializeValue(input.pictureDuration()));
      return arguments;
    }

    @Override
    public scheduling.procedures.ScheduleHopTraverse instantiate(
        final Map<String, SerializedValue> arguments) throws InstantiationException {
      final var defaults = new scheduling.procedures.ScheduleHopTraverse.Defaults();
      Optional<String> sites = Optional.empty();
      Optional<String> order = Optional.empty();
      Optional<Duration> startAfter = Optional.empty();
      Optional<Duration> restAfterHop = Optional.empty();
      Optional<Duration> pictureDuration = Optional.empty();

      sites = Optional.ofNullable(defaults.sites);
      order = Optional.ofNullable(defaults.order);
      startAfter = Optional.ofNullable(defaults.startAfter);
      restAfterHop = Optional.ofNullable(defaults.restAfterHop);
      pictureDuration = Optional.ofNullable(defaults.pictureDuration);

      final var instantiationExBuilder = new InstantiationException.Builder("ScheduleHopTraverse");

      for (final var entry : arguments.entrySet()) {
        try {
          switch (entry.getKey()) {
            case "sites":
              sites = Optional.ofNullable(this.mapper_sites.deserializeValue(entry.getValue())
                  .getSuccessOrThrow(failure -> new UnconstructableArgumentException("sites", failure)));
              break;
            case "order":
              order = Optional.ofNullable(this.mapper_order.deserializeValue(entry.getValue())
                  .getSuccessOrThrow(failure -> new UnconstructableArgumentException("order", failure)));
              break;
            case "startAfter":
              startAfter = Optional.ofNullable(this.mapper_startAfter.deserializeValue(entry.getValue())
                  .getSuccessOrThrow(failure -> new UnconstructableArgumentException("startAfter", failure)));
              break;
            case "restAfterHop":
              restAfterHop = Optional.ofNullable(this.mapper_restAfterHop.deserializeValue(entry.getValue())
                  .getSuccessOrThrow(failure -> new UnconstructableArgumentException("restAfterHop", failure)));
              break;
            case "pictureDuration":
              pictureDuration = Optional.ofNullable(this.mapper_pictureDuration.deserializeValue(entry.getValue())
                  .getSuccessOrThrow(failure -> new UnconstructableArgumentException("pictureDuration", failure)));
              break;
            default:
              instantiationExBuilder.withExtraneousArgument(entry.getKey());
          }
        } catch (final UnconstructableArgumentException e) {
          instantiationExBuilder.withUnconstructableArgument(e.parameterName, e.failure);
        }
      }

      sites.ifPresentOrElse(
          value -> instantiationExBuilder.withValidArgument("sites", this.mapper_sites.serializeValue(value)),
          () -> instantiationExBuilder.withMissingArgument("sites", this.mapper_sites.getValueSchema()));
      order.ifPresentOrElse(
          value -> instantiationExBuilder.withValidArgument("order", this.mapper_order.serializeValue(value)),
          () -> instantiationExBuilder.withMissingArgument("order", this.mapper_order.getValueSchema()));
      startAfter.ifPresentOrElse(
          value -> instantiationExBuilder.withValidArgument("startAfter", this.mapper_startAfter.serializeValue(value)),
          () -> instantiationExBuilder.withMissingArgument("startAfter", this.mapper_startAfter.getValueSchema()));
      restAfterHop.ifPresentOrElse(
          value -> instantiationExBuilder.withValidArgument("restAfterHop", this.mapper_restAfterHop.serializeValue(value)),
          () -> instantiationExBuilder.withMissingArgument("restAfterHop", this.mapper_restAfterHop.getValueSchema()));
      pictureDuration.ifPresentOrElse(
          value -> instantiationExBuilder.withValidArgument("pictureDuration", this.mapper_pictureDuration.serializeValue(value)),
          () -> instantiationExBuilder.withMissingArgument("pictureDuration", this.mapper_pictureDuration.getValueSchema()));

      instantiationExBuilder.throwIfAny();
      return new scheduling.procedures.ScheduleHopTraverse(sites.get(), order.get(), startAfter.get(), restAfterHop.get(), pictureDuration.get());
    }

    @Override
    public List<InputType.ValidationNotice> getValidationFailures(
        final scheduling.procedures.ScheduleHopTraverse input) {
      final var notices = new ArrayList<InputType.ValidationNotice>();
      return notices;
    }
  }
}
